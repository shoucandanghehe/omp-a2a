import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureDir,
	memberPath,
	membersDir,
	projectDir,
	projectMetaPath,
	projectsRoot,
} from "./paths";
import type { A2aMember, A2aProject, JoinOptions, ListMembersOptions, MemberRegistration } from "./types";
import { AGENT_ID_RE, OFFLINE_MS, PROJECT_NAME_RE, STALE_MS } from "./types";

export class RegistryConflictError extends Error {}

type StoredMember = A2aMember & { leaseId: string };

function publicMember(member: StoredMember): A2aMember {
	const { leaseId: _leaseId, ...publicValue } = member;
	return publicValue;
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

function writeJsonAtomic(file: string, data: unknown): void {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// Best effort on filesystems without chmod.
	}
}

function assertProjectName(name: string): void {
	if (!PROJECT_NAME_RE.test(name)) {
		throw new Error(`invalid project name "${name}" (use [a-zA-Z0-9._-], start alnum, max 64)`);
	}
}

function assertAgentId(id: string): void {
	if (!AGENT_ID_RE.test(id)) {
		throw new Error(`invalid agentId "${id}" (use [a-zA-Z0-9._-], start alnum, max 32)`);
	}
}

function refreshMember<T extends A2aMember>(member: T, now = Date.now()): T {
	if (member.status === "offline") return member;
	const age = now - member.lastSeenAt;
	const status = age > OFFLINE_MS ? "offline" : age > STALE_MS ? "stale" : "online";
	return status === member.status ? member : { ...member, status };
}

export function createProject(opts: {
	name: string;
	displayName?: string;
	description?: string;
	createdByCwd?: string;
	dataDir?: string;
}): A2aProject {
	assertProjectName(opts.name);
	const metaPath = projectMetaPath(opts.name, opts.dataDir);
	if (fs.existsSync(metaPath)) throw new RegistryConflictError(`project already exists: ${opts.name}`);
	ensureDir(membersDir(opts.name, opts.dataDir));
	const project: A2aProject = {
		name: opts.name,
		displayName: opts.displayName,
		description: opts.description,
		createdAt: Date.now(),
		createdByCwd: opts.createdByCwd,
	};
	writeJsonAtomic(metaPath, project);
	return project;
}

export function deleteProject(name: string, dataDir?: string): boolean {
	assertProjectName(name);
	if (!getProject(name, dataDir)) return false;
	const active = listMembers({ project: name, all: true, dataDir }).filter((member) => member.status !== "offline");
	if (active.length > 0) {
		throw new RegistryConflictError(`project has active members: ${active.map((member) => member.agentId).join(", ")}`);
	}
	fs.rmSync(projectDir(name, dataDir), { recursive: true });
	return true;
}

export function getProject(name: string, dataDir?: string): A2aProject | null {
	assertProjectName(name);
	return readJson<A2aProject>(projectMetaPath(name, dataDir));
}

export function listProjects(dataDir?: string): A2aProject[] {
	const root = projectsRoot(dataDir);
	if (!fs.existsSync(root)) return [];
	const projects: A2aProject[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !PROJECT_NAME_RE.test(entry.name)) continue;
		const project = getProject(entry.name, dataDir);
		if (project) projects.push(project);
	}
	return projects.sort((left, right) => left.name.localeCompare(right.name));
}

function readStoredMember(project: string, agentId: string, dataDir?: string): StoredMember | null {
	return readJson<StoredMember>(memberPath(project, agentId, dataDir));
}

export function readMember(project: string, agentId: string, dataDir?: string): A2aMember | null {
	assertProjectName(project);
	assertAgentId(agentId);
	const stored = readStoredMember(project, agentId, dataDir);
	return stored ? publicMember(refreshMember(stored)) : null;
}

export function listMembers(opts: ListMembersOptions & { dataDir?: string }): A2aMember[] {
	assertProjectName(opts.project);
	if (!getProject(opts.project, opts.dataDir)) throw new Error(`unknown project: ${opts.project}`);
	const dir = membersDir(opts.project, opts.dataDir);
	if (!fs.existsSync(dir)) return [];

	const members: A2aMember[] = [];
	const now = Date.now();
	for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
		const stored = readJson<StoredMember>(path.join(dir, file));
		if (!stored?.agentId) continue;
		const member = publicMember(refreshMember(stored, now));
		if (opts.all || member.status === "online") members.push(member);
	}
	return members.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export function joinProject(opts: JoinOptions & { dataDir?: string }): MemberRegistration {
	assertProjectName(opts.project);
	assertAgentId(opts.agentId);
	if (!getProject(opts.project, opts.dataDir)) {
		throw new Error(`unknown project: ${opts.project} (create it first with /a2a project create)`);
	}

	const existing = readMember(opts.project, opts.agentId, opts.dataDir);
	if (existing?.status === "online") {
		throw new RegistryConflictError(
			`agentId "${opts.agentId}" already online in project "${opts.project}" (pid ${existing.pid}, cwd ${existing.cwd})`,
		);
	}

	const now = Date.now();
	const leaseId = crypto.randomUUID();
	const member: A2aMember = {
		agentId: opts.agentId,
		project: opts.project,
		cwd: opts.cwd,
		pid: opts.pid ?? process.pid,
		sessionId: opts.sessionId,
		caps: opts.caps ?? [],
		displayName: opts.displayName,
		joinedAt: now,
		lastSeenAt: now,
		status: "online",
	};
	writeJsonAtomic(memberPath(opts.project, opts.agentId, opts.dataDir), { ...member, leaseId } satisfies StoredMember);
	return { member, leaseId };
}

export function heartbeat(project: string, agentId: string, leaseId: string, dataDir?: string): A2aMember {
	assertProjectName(project);
	assertAgentId(agentId);
	const stored = readStoredMember(project, agentId, dataDir);
	if (!stored) throw new Error(`not a member: ${agentId}@${project}`);
	if (!leaseId || stored.leaseId !== leaseId) throw new Error(`lease ownership mismatch: ${agentId}@${project}`);
	if (stored.status === "offline") throw new Error(`member is offline: ${agentId}@${project}`);
	const next: StoredMember = { ...stored, lastSeenAt: Date.now(), status: "online" };
	writeJsonAtomic(memberPath(project, agentId, dataDir), next);
	return publicMember(next);
}

export function leaveProject(project: string, agentId: string, leaseId: string, dataDir?: string): void {
	assertProjectName(project);
	assertAgentId(agentId);
	const stored = readStoredMember(project, agentId, dataDir);
	if (!stored) throw new Error(`not a member: ${agentId}@${project}`);
	if (!leaseId || stored.leaseId !== leaseId) throw new Error(`lease ownership mismatch: ${agentId}@${project}`);
	if (stored.status === "offline") return;
	writeJsonAtomic(memberPath(project, agentId, dataDir), {
		...stored,
		status: "offline",
		lastSeenAt: Date.now(),
	} satisfies StoredMember);
}

export function authorizeInboxAccess(
	project: string,
	agentId: string,
	leaseId?: string,
	dataDir?: string,
): void {
	assertProjectName(project);
	assertAgentId(agentId);
	const stored = readStoredMember(project, agentId, dataDir);
	if (!stored) throw new Error(`not a member: ${agentId}@${project}`);
	const member = refreshMember(stored);
	if (member.status === "offline") throw new Error(`member is offline: ${agentId}@${project}`);
	if (!leaseId || member.leaseId !== leaseId) throw new Error(`lease ownership mismatch: ${agentId}@${project}`);
}

export function formatMembersTable(members: A2aMember[]): string {
	if (members.length === 0) return "(no members)";
	return members
		.map((member) => {
			const caps = member.caps.length > 0 ? member.caps.join(",") : "-";
			return `- ${member.agentId}\t${member.status}\tpid=${member.pid}\tcwd=${member.cwd}\tcaps=${caps}`;
		})
		.join("\n");
}

export function hostnameHint(): string {
	return os.hostname();
}

export { projectDir, projectsRoot };
