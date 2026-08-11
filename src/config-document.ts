import { YAML } from "bun";

/** Parse configuration syntax without assigning a schema to the document. */
export function parseConfigDocument(text: string, file: string): unknown {
	return file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
}
