import {
	type as schemaType,
	type OmpErrors,
	type Type,
} from "@oh-my-pi/omptype";
import { YAML } from "bun";
import * as fs from "node:fs";

interface ParseWithSchemaOptions {
	label: string;
	formatErrors?: (errors: OmpErrors) => string | undefined;
}

/** Read and parse one YAML/JSON document, then apply its owner's exact schema. */
export function parseWithSchema<output, input>(
	file: string,
	schema: Type<output, input>,
	options: ParseWithSchemaOptions,
): output {
	try {
		const text = fs.readFileSync(file, "utf8");
		const document = file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
		const result = schema(document);
		if (result instanceof schemaType.errors) {
			throw new Error(options.formatErrors?.(result) ?? result.summary);
		}
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid ${options.label} at ${file}: ${message}`, {
			cause: error,
		});
	}
}
