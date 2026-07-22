/** Stable name claimed by one omp process inside a collaboration project. */
export interface A2aMember {
	agentId: string;
	project: string;
	cwd: string;
	/** Diagnostic metadata only; presence is derived exclusively from heartbeat time. */
	pid: number;
	sessionId?: string;
	caps: string[];
	displayName?: string;
	joinedAt: number;
	lastSeenAt: number;
	status: "online" | "offline" | "stale";
}

/** Public member data paired with the opaque token controlling that registration. */
export interface MemberRegistration {
	member: A2aMember;
	leaseId: string;
}

/** Explicit collaboration domain spanning multiple project directories / omp processes. */
export interface A2aProject {
	name: string;
	displayName?: string;
	description?: string;
	createdAt: number;
	createdByCwd?: string;
}

/** Per-repo local config: <repo>/.omp/a2a.yml or a2a.json */
export interface A2aLocalConfig {
	project: string;
	agentId: string;
	/** Override Hub base URL for this repo. */
	hubUrl?: string;
	caps?: string[];
	displayName?: string;
	autoJoin?: boolean;
}

export interface JoinOptions {
	project: string;
	agentId: string;
	cwd: string;
	pid?: number;
	sessionId?: string;
	caps?: string[];
	displayName?: string;
}

export interface ListMembersOptions {
	project: string;
	/** Include offline/stale members. Default false (online only). */
	all?: boolean;
}

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 15_000;
export const OFFLINE_MS = STALE_MS * 4;
export const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
