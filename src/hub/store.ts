import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../paths";
import type { A2aProject } from "../types";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "../types";
import { decodeTextPayload, parseEncodedAttachments } from "./payload";
import {
	formatMessageRef,
	type HistoryPage,
	type HistoryQuery,
	MESSAGE_ID_RE,
	type MessageTarget,
	parseMessageRef,
	type RealtimeMessage,
} from "./realtime-types";
import type { EncodedAttachment, EncodedTextPayload } from "./types";

export const MESSAGE_STORAGE_VERSION = 1;
const UNSUPPORTED_STORAGE_MESSAGE =
	"unsupported pre-release storage; start with an empty data directory";

export class MessageIdConflictError extends Error {}
export class ProjectConflictError extends Error {}
export class UnknownProjectError extends Error {}
export class UnknownReplyTargetError extends Error {}
export type MessageDraft = {
	messageId: string;
	project: string;
	from: { name: string; presenceId: string };
	target: MessageTarget;
	payload: EncodedTextPayload;
	attachments: EncodedAttachment[];
	createdAt: number;
	replyTo?: string;
};

export type MessageAppendResult =
	| { replayed: false; message: RealtimeMessage }
	| { replayed: true; message: RealtimeMessage };

type MessageRow = {
	project: string;
	project_sequence: number;
	msg_id: string;
	sender_name: string;
	sender_presence_id: string;
	target_kind: string;
	target_name: string | null;
	target_presence_id: string | null;
	encoding: string;
	data: string;
	attachments: string;
	created_at: number;
	reply_to_sequence: number | null;
};

type ProjectRow = {
	name: string;
	display_name: string | null;
	description: string | null;
	created_at: number;
	created_by_cwd: string | null;
};

type SequenceRow = { next_sequence: number };

const PROJECTS_SCHEMA = `
	CREATE TABLE projects (
		name TEXT PRIMARY KEY,
		display_name TEXT,
		description TEXT,
		created_at INTEGER NOT NULL,
		created_by_cwd TEXT
	)
`;

const PROJECT_SEQUENCES_SCHEMA = `
	CREATE TABLE project_sequences (
		project TEXT PRIMARY KEY NOT NULL,
		next_sequence INTEGER NOT NULL
	)
`;

const MESSAGES_SCHEMA = `
	CREATE TABLE messages (
		project TEXT NOT NULL,
		project_sequence INTEGER NOT NULL,
		msg_id TEXT NOT NULL UNIQUE,
		sender_name TEXT NOT NULL,
		sender_presence_id TEXT NOT NULL,
		target_kind TEXT NOT NULL,
		target_name TEXT,
		target_presence_id TEXT,
		encoding TEXT NOT NULL,
		data TEXT NOT NULL,
		attachments TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		reply_to_sequence INTEGER,
		PRIMARY KEY(project, project_sequence)
	)
`;

const MESSAGES_PROJECT_SENDER_INDEX_SCHEMA =
	"CREATE INDEX messages_project_sender ON messages(project, sender_name, project_sequence)";

function normalizeSchema(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

const CURRENT_SCHEMA = [
	{
		type: "index",
		name: "messages_project_sender",
		sql: normalizeSchema(MESSAGES_PROJECT_SENDER_INDEX_SCHEMA),
	},
	{
		type: "table",
		name: "messages",
		sql: normalizeSchema(MESSAGES_SCHEMA),
	},
	{
		type: "table",
		name: "project_sequences",
		sql: normalizeSchema(PROJECT_SEQUENCES_SCHEMA),
	},
	{
		type: "table",
		name: "projects",
		sql: normalizeSchema(PROJECTS_SCHEMA),
	},
];

function assertProjectName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !PROJECT_NAME_RE.test(name)) {
		throw new Error(
			`invalid project name "${String(name)}" (use [a-zA-Z0-9._-], start alnum, max 64)`,
		);
	}
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new Error(`Project ${field} must be a string`);
	return value;
}

function toProject(row: ProjectRow): A2aProject {
	return {
		name: row.name,
		displayName: row.display_name ?? undefined,
		description: row.description ?? undefined,
		createdAt: row.created_at,
		createdByCwd: row.created_by_cwd ?? undefined,
	};
}

export class HubStore {
	#database: Database;
	#allocateSequence;
	#deleteProject;
	#findById;
	#findByRef;
	#findProject;
	#insert;
	#insertProject;
	#append;

	constructor(databasePath: string) {
		const databaseExisted = existsSync(databasePath);
		ensureDir(path.dirname(databasePath));
		this.#database = new Database(databasePath, { create: true });
		try {
			this.#initializeSchema(databaseExisted);
			this.#database.run("PRAGMA journal_mode = WAL");
			this.#database.run("PRAGMA synchronous = FULL");
			this.#allocateSequence = this.#database.query<SequenceRow, [string]>(`
				INSERT INTO project_sequences(project, next_sequence)
				VALUES (?, 1)
				ON CONFLICT(project) DO UPDATE
				SET next_sequence = next_sequence + 1
				RETURNING next_sequence
			`);
			this.#findById = this.#database.query<MessageRow, [string]>(
				"SELECT * FROM messages WHERE msg_id = ?",
			);
			this.#findByRef = this.#database.query<MessageRow, [string, number]>(
				"SELECT * FROM messages WHERE project = ? AND project_sequence = ?",
			);
			this.#findProject = this.#database.query<ProjectRow, [string]>(
				"SELECT * FROM projects WHERE name = ?",
			);
			this.#insert = this.#database.query(`
				INSERT INTO messages(
					project, project_sequence, msg_id, sender_name, sender_presence_id,
					target_kind, target_name, target_presence_id, encoding, data,
					attachments, created_at, reply_to_sequence
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			this.#insertProject = this.#database.query(`
				INSERT INTO projects(
					name, display_name, description, created_at, created_by_cwd
				) VALUES (?, ?, ?, ?, ?)
			`);
			this.#deleteProject = this.#database.transaction(
				(project: string): boolean => {
					if (!this.#findProject.get(project)) return false;
					this.#database
						.query("DELETE FROM messages WHERE project = ?")
						.run(project);
					this.#database
						.query("DELETE FROM project_sequences WHERE project = ?")
						.run(project);
					this.#database.query("DELETE FROM projects WHERE name = ?").run(project);
					return true;
				},
			);
			this.#append = this.#database.transaction(
				(draft: MessageDraft): MessageAppendResult => {
					const attachments = this.#validateDraft(draft);
					if (!this.#findProject.get(draft.project)) {
						throw new UnknownProjectError(
							`unknown project: ${draft.project}`,
						);
					}
					const replyToSequence = this.#resolveReply(
						draft.project,
						draft.replyTo,
					);
					const existing = this.#findById.get(draft.messageId);
					if (existing) {
						if (!this.#matches(existing, draft, attachments, replyToSequence)) {
							throw new MessageIdConflictError(
								`messageId already used with different content: ${draft.messageId}`,
							);
						}
						return { replayed: true, message: this.#toMessage(existing) };
					}
					const sequence = this.#allocateSequence.get(
						draft.project,
					)?.next_sequence;
					if (!sequence)
						throw new Error(
							`failed to allocate message sequence for ${draft.project}`,
						);
					this.#insert.run(
						draft.project,
						sequence,
						draft.messageId,
						draft.from.name,
						draft.from.presenceId,
						draft.target.type,
						draft.target.type === "agent" ? draft.target.name : null,
						draft.target.type === "agent"
							? (draft.target.presenceId ?? null)
							: null,
						draft.payload.encoding,
						draft.payload.data,
						JSON.stringify(attachments),
						draft.createdAt,
						replyToSequence,
					);
					return {
						replayed: false,
						message: {
							messageId: draft.messageId,
							messageRef: formatMessageRef(draft.project, sequence),
							project: draft.project,
							sequence,
							from: { ...draft.from },
							target: { ...draft.target },
							payload: { ...draft.payload },
							attachments: attachments.map((attachment) => ({
								name: attachment.name,
								payload: { ...attachment.payload },
							})),
							createdAt: draft.createdAt,
							replyTo: draft.replyTo,
						},
					};
				},
			);
		} catch (error) {
			this.#database.close();
			throw error;
		}
	}

	replay(
		draft: MessageDraft,
	): Extract<MessageAppendResult, { replayed: true }> | null {
		const existing = this.#findById.get(draft.messageId);
		if (!existing) return null;
		const attachments = this.#validateDraft(draft);
		const replyToSequence = this.#resolveReply(draft.project, draft.replyTo);
		if (!this.#matches(existing, draft, attachments, replyToSequence)) {
			throw new MessageIdConflictError(
				`messageId already used with different content: ${draft.messageId}`,
			);
		}
		return { replayed: true, message: this.#toMessage(existing) };
	}

	createProject(options: {
		name: string;
		displayName?: string;
		description?: string;
		createdByCwd?: string;
	}): A2aProject {
		assertProjectName(options.name);
		const displayName = optionalString(options.displayName, "displayName");
		const description = optionalString(options.description, "description");
		const createdByCwd = optionalString(options.createdByCwd, "createdByCwd");
		if (this.#findProject.get(options.name)) {
			throw new ProjectConflictError(
				`project already exists: ${options.name}`,
			);
		}
		const project: A2aProject = {
			name: options.name,
			displayName,
			description,
			createdAt: Date.now(),
			createdByCwd,
		};
		this.#insertProject.run(
			project.name,
			project.displayName ?? null,
			project.description ?? null,
			project.createdAt,
			project.createdByCwd ?? null,
		);
		return project;
	}

	getProject(name: string): A2aProject | null {
		assertProjectName(name);
		const row = this.#findProject.get(name);
		return row ? toProject(row) : null;
	}

	listProjects(): A2aProject[] {
		return this.#database
			.query<ProjectRow, []>("SELECT * FROM projects")
			.all()
			.map(toProject)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	deleteProject(project: string): boolean {
		assertProjectName(project);
		return this.#deleteProject.immediate(project);
	}

	append(draft: MessageDraft): MessageAppendResult {
		return this.#append(draft);
	}

	get(reference: string): RealtimeMessage | null {
		const parsed = parseMessageRef(reference);
		const row = this.#findByRef.get(parsed.project, parsed.sequence);
		return row ? this.#toMessage(row) : null;
	}

	history(query: HistoryQuery): HistoryPage {
		if (!PROJECT_NAME_RE.test(query.project))
			throw new Error(`invalid project: ${query.project}`);
		if (!this.#findProject.get(query.project)) {
			throw new UnknownProjectError(`unknown project: ${query.project}`);
		}
		if (query.before && query.after)
			throw new Error("history accepts before or after, not both");
		if (query.from !== undefined && !AGENT_NAME_RE.test(query.from))
			throw new Error(`invalid name: ${query.from}`);
		const limit = query.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit <= 0)
			throw new Error("history limit must be a positive integer");
		const params: Array<string | number> = [query.project];
		const predicates = ["project = ?"];
		let ascending = false;
		if (query.before) {
			const ref = parseMessageRef(query.before);
			if (ref.project !== query.project)
				throw new Error("history cursor belongs to another project");
			predicates.push("project_sequence < ?");
			params.push(ref.sequence);
		} else if (query.after) {
			const ref = parseMessageRef(query.after);
			if (ref.project !== query.project)
				throw new Error("history cursor belongs to another project");
			predicates.push("project_sequence > ?");
			params.push(ref.sequence);
			ascending = true;
		}
		if (query.from) {
			predicates.push("sender_name = ?");
			params.push(query.from);
		}
		const order = ascending ? "ASC" : "DESC";
		params.push(limit);
		const rows = this.#database
			.query<MessageRow, Array<string | number>>(
				`SELECT * FROM messages
				WHERE ${predicates.join(" AND ")}
				ORDER BY project_sequence ${order}
				LIMIT ?`,
			)
			.all(...params);
		if (!ascending) rows.reverse();
		return { messages: rows.map((row) => this.#toMessage(row)) };
	}

	integrityCheck(): string {
		return (
			this.#database
				.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
				.get()?.integrity_check ?? "unknown"
		);
	}

	close(): void {
		this.#database.close();
	}

	#initializeSchema(databaseExisted: boolean): void {
		this.#database.transaction(() => {
			const schema = this.#database
				.query<{ type: string; name: string; sql: string | null }, []>(
					"SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
				)
				.all()
				.map(({ type, name, sql }) => ({
					type,
					name,
					sql: normalizeSchema(sql ?? ""),
				}));
			const version =
				this.#database
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version ?? 0;
			if (schema.length === 0 && version === 0) {
				if (databaseExisted) throw new Error(UNSUPPORTED_STORAGE_MESSAGE);
				this.#database.run(PROJECTS_SCHEMA);
				this.#database.run(PROJECT_SEQUENCES_SCHEMA);
				this.#database.run(MESSAGES_SCHEMA);
				this.#database.run(MESSAGES_PROJECT_SENDER_INDEX_SCHEMA);
				this.#database.run(
					`PRAGMA user_version = ${MESSAGE_STORAGE_VERSION}`,
				);
				return;
			}
			if (
				version !== MESSAGE_STORAGE_VERSION ||
				JSON.stringify(schema) !== JSON.stringify(CURRENT_SCHEMA)
			) {
				throw new Error(UNSUPPORTED_STORAGE_MESSAGE);
			}
		})();
	}

	#resolveReply(project: string, replyTo: string | undefined): number | null {
		if (!replyTo) return null;
		const parsed = parseMessageRef(replyTo);
		if (parsed.project !== project)
			throw new UnknownReplyTargetError("replyTo belongs to another project");
		if (!this.#findByRef.get(project, parsed.sequence))
			throw new UnknownReplyTargetError(`unknown replyTo: ${replyTo}`);
		return parsed.sequence;
	}

	#validateDraft(draft: MessageDraft): EncodedAttachment[] {
		if (!MESSAGE_ID_RE.test(draft.messageId))
			throw new Error(`invalid messageId: ${draft.messageId}`);
		if (!PROJECT_NAME_RE.test(draft.project))
			throw new Error(`invalid project: ${draft.project}`);
		if (!AGENT_NAME_RE.test(draft.from.name))
			throw new Error(`invalid sender name: ${draft.from.name}`);
		if (!draft.from.presenceId)
			throw new Error("sender presenceId is required");
		if (
			draft.target.type === "agent" &&
			!AGENT_NAME_RE.test(draft.target.name)
		) {
			throw new Error(`invalid recipient name: ${draft.target.name}`);
		}
		if (!Number.isSafeInteger(draft.createdAt) || draft.createdAt < 0)
			throw new Error("invalid createdAt");
		if (decodeTextPayload(draft.payload).trim().length === 0)
			throw new Error("message text required");
		return parseEncodedAttachments(draft.attachments);
	}

	#matches(
		row: MessageRow,
		draft: MessageDraft,
		attachments: EncodedAttachment[],
		replyToSequence: number | null,
	): boolean {
		return (
			row.project === draft.project &&
			row.sender_name === draft.from.name &&
			row.target_kind === draft.target.type &&
			row.target_name ===
				(draft.target.type === "agent" ? draft.target.name : null) &&
			row.encoding === draft.payload.encoding &&
			row.data === draft.payload.data &&
			row.attachments === JSON.stringify(attachments) &&
			row.reply_to_sequence === replyToSequence
		);
	}

	#toMessage(row: MessageRow): RealtimeMessage {
		if (row.target_kind !== "agent" && row.target_kind !== "project") {
			throw new Error(`invalid stored target kind: ${row.target_kind}`);
		}
		const target: MessageTarget =
			row.target_kind === "agent"
				? {
						type: "agent",
						name: row.target_name ?? "",
						presenceId: row.target_presence_id ?? undefined,
					}
				: { type: "project" };
		const payload: EncodedTextPayload = {
			encoding: row.encoding as EncodedTextPayload["encoding"],
			data: row.data,
		};
		const attachments = parseEncodedAttachments(JSON.parse(row.attachments));
		return {
			messageId: row.msg_id,
			messageRef: formatMessageRef(row.project, row.project_sequence),
			project: row.project,
			sequence: row.project_sequence,
			from: {
				name: row.sender_name,
				presenceId: row.sender_presence_id,
			},
			target,
			payload,
			attachments,
			createdAt: row.created_at,
			replyTo:
				row.reply_to_sequence == null
					? undefined
					: formatMessageRef(row.project, row.reply_to_sequence),
		};
	}
}
