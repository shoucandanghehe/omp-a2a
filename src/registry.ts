import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, projectDir, projectMetaPath, projectsRoot } from "./paths";
import type { A2aProject } from "./types";
import { PROJECT_NAME_RE } from "./types";

export class RegistryOperationError extends Error {}
export class RegistryConflictError extends RegistryOperationError {}
export class RegistryPersistenceError extends Error {}

function assertProjectName(name: string): void {
	if (!PROJECT_NAME_RE.test(name)) {
		throw new RegistryOperationError(
			`invalid project name "${name}" (use [a-zA-Z0-9._-], start alnum, max 64)`,
		);
	}
}

function readProjectFile(file: string): A2aProject | null {
	let source: string;
	try {
		source = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw new RegistryPersistenceError(
			`failed to read Registry JSON ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return JSON.parse(source) as A2aProject;
	} catch (error) {
		throw new RegistryPersistenceError(
			`invalid Registry JSON ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function writeJsonAtomic(file: string, data: unknown): void {
	ensureDir(path.dirname(file));
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
		mode: 0o600,
	});
	fs.renameSync(temporary, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// Best effort on filesystems without chmod.
	}
}

export function createProject(options: {
	name: string;
	displayName?: string;
	description?: string;
	createdByCwd?: string;
	dataDir?: string;
}): A2aProject {
	assertProjectName(options.name);
	const metadataPath = projectMetaPath(options.name, options.dataDir);
	if (fs.existsSync(metadataPath))
		throw new RegistryConflictError(`project already exists: ${options.name}`);
	const project: A2aProject = {
		name: options.name,
		displayName: options.displayName,
		description: options.description,
		createdAt: Date.now(),
		createdByCwd: options.createdByCwd,
	};
	writeJsonAtomic(metadataPath, project);
	return project;
}

export function deleteProject(name: string, dataDir?: string): boolean {
	assertProjectName(name);
	const existed = getProject(name, dataDir) !== null;
	fs.rmSync(projectDir(name, dataDir), { recursive: true, force: true });
	return existed;
}

export function getProject(name: string, dataDir?: string): A2aProject | null {
	assertProjectName(name);
	return readProjectFile(projectMetaPath(name, dataDir));
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

export { projectDir, projectsRoot };
