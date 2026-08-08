import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default storage root for one Hub instance. */
export function defaultDataDir(home: string = os.homedir()): string {
	return path.join(home, ".omp", "a2a");
}

/** Root containing global client configuration. */
export function a2aRoot(home: string = os.homedir()): string {
	return defaultDataDir(home);
}

export function projectsRoot(dataDir: string = defaultDataDir()): string {
	return path.join(dataDir, "projects");
}

export function projectDir(project: string, dataDir?: string): string {
	return path.join(projectsRoot(dataDir), project);
}

export function projectMetaPath(project: string, dataDir?: string): string {
	return path.join(projectDir(project, dataDir), "project.json");
}

export function hubRunDir(dataDir: string = defaultDataDir()): string {
	return path.join(dataDir, "run");
}

export function hubMetaPath(dataDir?: string): string {
	return path.join(hubRunDir(dataDir), "hub.json");
}

export function hubPidPath(dataDir?: string): string {
	return path.join(hubRunDir(dataDir), "hub.pid");
}

export function hubLockPath(dataDir?: string): string {
	return path.join(hubRunDir(dataDir), "hub-lock.sqlite");
}

export function inboxDatabasePath(dataDir: string = defaultDataDir()): string {
	return path.join(dataDir, "inbox.sqlite");
}

export function messageDatabasePath(
	dataDir: string = defaultDataDir(),
): string {
	return path.join(dataDir, "messages.sqlite");
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** Candidate local config paths inside a project cwd. */
export function localConfigCandidates(cwd: string): string[] {
	return [
		path.join(cwd, ".omp", "a2a.yml"),
		path.join(cwd, ".omp", "a2a.yaml"),
		path.join(cwd, ".omp", "a2a.json"),
	];
}
