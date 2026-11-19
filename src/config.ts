import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { type OmpErrors, type as omptype } from "@oh-my-pi/omptype";
import { YAML } from "bun";
import { parseWithSchema } from "./config-document";
import { ensureDir, localConfigCandidates } from "./paths";
import type { A2aLocalConfig, A2aRoomConnection } from "./types";
import { AGENT_NAME_RE, ROOM_NAME_RE } from "./types";

const trimmedNonBlankString = omptype("string")
	.pipe((value) => value.trim())
	.narrow(
		(value, context) =>
			value.length > 0 || context.mustBe("a non-blank string"),
	);

const roomName = trimmedNonBlankString.narrow(
	(value, context) =>
		ROOM_NAME_RE.test(value) ||
		context.mustBe("a valid Room name using [a-zA-Z0-9._-], max 64"),
);

const agentName = trimmedNonBlankString.narrow(
	(value, context) =>
		AGENT_NAME_RE.test(value) ||
		context.mustBe(
			"a valid Agent name using Unicode letters, numbers, marks, or ._-, max 32 characters",
		),
);

const roomConnection = { room: roomName, name: agentName };
const localSettings = {
	"hubUrl?": trimmedNonBlankString,
	autoConnect: omptype("boolean").default(true),
	"+": "reject",
} as const;

const flatConfigSchema = omptype({ ...roomConnection, ...localSettings });
const roomsConfigSchema = omptype({
	rooms: omptype({ ...roomConnection, "+": "reject" })
		.array()
		.atLeastLength(1)
		.narrow(
			(rooms, context) =>
				new Set(rooms.map(({ room }) => room)).size === rooms.length ||
				context.mustBe("a list with unique Room names"),
		),
	...localSettings,
});

// Select by the presence of `rooms` so validation retains the field errors
// from the relevant shape, including the original flat configuration errors.
const localConfigSchema = omptype("unknown").pipe((document) =>
	typeof document === "object" &&
	document !== null &&
	Object.hasOwn(document, "rooms")
		? roomsConfigSchema(document)
		: flatConfigSchema(document),
);

function formatLocalConfigErrors(errors: OmpErrors): string | undefined {
	for (const error of errors) {
		const field = error.path[0];
		if (field === "project") {
			return 'a2a config field "project" was renamed to "room"';
		}
		if (
			field === "agentId" ||
			field === "agent_id" ||
			field === "autoJoin" ||
			field === "auto_join"
		) {
			return `a2a config field "${field}" was removed; rename agentId to name and autoJoin to autoConnect`;
		}
	}
	return undefined;
}

function readLocalConfig(cwd: string) {
	const candidates = localConfigCandidates(cwd);
	const file = candidates.find((candidate) => fs.existsSync(candidate));
	return file
		? {
				file,
				config: parseWithSchema(file, localConfigSchema, {
					label: "a2a config",
					formatErrors: formatLocalConfigErrors,
				}),
			}
		: { file: candidates[0], config: null };
}

/** Load first existing local a2a config under cwd, or null if absent. */
export function loadLocalConfig(cwd: string): A2aLocalConfig | null {
	const { config } = readLocalConfig(cwd);
	if (!config || "rooms" in config) return config;
	const { room, name, ...settings } = config;
	return { rooms: [{ room, name }], ...settings };
}

export function saveLocalConnections(
	cwd: string,
	target: { rooms: readonly A2aRoomConnection[]; hubUrl: string },
): string {
	const { file, config } = readLocalConfig(cwd);
	const settings = { hubUrl: target.hubUrl, autoConnect: true };
	const saved = localConfigSchema.assert(
		target.rooms.length === 1
			? { ...target.rooms[0], ...settings }
			: { rooms: target.rooms, ...settings },
	);
	if (config && config.hubUrl === saved.hubUrl && config.autoConnect) {
		if ("rooms" in saved) {
			if (
				"rooms" in config &&
				config.rooms.length === saved.rooms.length &&
				config.rooms.every(
					({ room, name }, index) =>
						room === saved.rooms[index]?.room &&
						name === saved.rooms[index]?.name,
				)
			) {
				return file;
			}
		} else if (
			!("rooms" in config) &&
			config.room === saved.room &&
			config.name === saved.name
		) {
			return file;
		}
	}

	const content = file.endsWith(".json")
		? JSON.stringify(saved, null, 2)
		: YAML.stringify(saved, null, 2);
	const dir = dirname(file);
	ensureDir(dir);
	// Publish a complete document so other Sessions can reload during a save.
	const tempDir = fs.mkdtempSync(join(dir, ".a2a-"));
	try {
		const tempFile = join(tempDir, "config");
		fs.writeFileSync(tempFile, `${content}\n`, {
			mode: config ? fs.statSync(file).mode & 0o777 : 0o600,
		});
		fs.renameSync(tempFile, file);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
	return file;
}
