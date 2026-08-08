/** Persistent collaboration room. */
export interface A2aProject {
	name: string;
	displayName?: string;
	description?: string;
	createdAt: number;
	createdByCwd?: string;
}

/** Per-repository connection defaults. */
export interface A2aLocalConfig {
	project: string;
	name: string;
	hubUrl?: string;
	autoConnect?: boolean;
}

export const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
