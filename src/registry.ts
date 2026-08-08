import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, projectDir, projectMetaPath, projectsRoot } from "./paths";
import type { A2aProject } from "./types";
import { PROJECT_NAME_RE } from "./types";

export class RegistryConflictError extends Error {}

function assertProjectName(name: string): void {
	if (!PROJECT_NAME_RE.test(name)) {
		throw new Error(
			`invalid project name "${name}" (use [a-zA-Z0-9._-], start alnum, max 64)`,
		);
	}
}

function readProjectFile(file: string): A2aProject | null {
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, "utf8")) as A2aProject;
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
	if (!getProject(name, dataDir)) return false;
	fs.rmSync(projectDir(name, dataDir), { recursive: true });
	return true;
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
