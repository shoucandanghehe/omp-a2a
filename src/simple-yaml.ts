/**
 * Parse the intentionally small YAML subset used by A2A configuration:
 * top-level scalar keys and one-level string lists.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	let listKey: string | null = null;
	let list: string[] = [];

	const flushList = () => {
		if (listKey !== null) {
			output[listKey] = list;
			listKey = null;
			list = [];
		}
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripYamlComment(rawLine).trimEnd();
		if (!line.trim()) continue;

		const listItem = line.match(/^\s*-\s+(.+)$/);
		if (listItem) {
			if (listKey === null) throw new Error("list item has no preceding key");
			list.push(parseYamlString(listItem[1]!.trim()));
			continue;
		}
		if (/^\s/.test(line)) {
			throw new Error(`unsupported nested YAML line: ${line.trim()}`);
		}

		flushList();
		const match = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (!match) throw new Error(`unsupported YAML line: ${line.trim()}`);
		const key = match[1]!;
		const value = match[2]!.trim();
		if (value === "") {
			listKey = key;
			continue;
		}
		if (value === "|" || value === ">") {
			throw new Error(`unsupported block scalar for ${key}`);
		}
		if (value.startsWith("[")) {
			if (!value.endsWith("]")) throw new Error(`invalid inline list for ${key}`);
			const inner = value.slice(1, -1).trim();
			output[key] = inner ? splitYamlList(inner).map(parseYamlString) : [];
			continue;
		}
		if (value === "true") {
			output[key] = true;
			continue;
		}
		if (value === "false") {
			output[key] = false;
			continue;
		}
		if (/^\d+$/.test(value)) {
			output[key] = Number(value);
			continue;
		}
		output[key] = parseYamlString(value);
	}
	flushList();
	return output;
}

function stripYamlComment(line: string): string {
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index]!;
		if (quote === '"' && escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && character === "\\") {
			escaped = true;
			continue;
		}
		if (quote === "'" && character === "'" && line[index + 1] === "'") {
			index += 1;
			continue;
		}
		if (character === quote) {
			quote = null;
			continue;
		}
		if (
			quote === null &&
			(character === "'" || character === '"') &&
			[":", "-", "[", ","].includes(line.slice(0, index).trimEnd().at(-1) ?? "")
		) {
			quote = character;
			continue;
		}
		if (quote === null && character === "#") return line.slice(0, index);
	}
	if (quote !== null) throw new Error("unterminated quoted scalar");
	return line;
}

function splitYamlList(value: string): string[] {
	const values: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!;
		if (quote === '"' && escaped) {
			escaped = false;
			continue;
		}
		if (quote === '"' && character === "\\") {
			escaped = true;
			continue;
		}
		if (quote === "'" && character === "'" && value[index + 1] === "'") {
			index += 1;
			continue;
		}
		if (character === quote) {
			quote = null;
			continue;
		}
		if (
			quote === null &&
			(character === "'" || character === '"') &&
			value.slice(start, index).trim().length === 0
		) {
			quote = character;
			continue;
		}
		if (quote === null && character === ",") {
			values.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	if (quote !== null) throw new Error("unterminated quoted list value");
	values.push(value.slice(start).trim());
	return values;
}

function parseYamlString(value: string): string {
	if (value.startsWith('"')) {
		if (!value.endsWith('"')) throw new Error("unterminated double-quoted scalar");
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch (error) {
			throw new Error("invalid double-quoted scalar", { cause: error });
		}
		if (typeof parsed !== "string") throw new Error("invalid double-quoted scalar");
		return parsed;
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'")) throw new Error("unterminated single-quoted scalar");
		return value.slice(1, -1).replace(/''/g, "'");
	}
	if (value.includes('"') && value.trimStart().startsWith('"')) {
		throw new Error("invalid quoted scalar");
	}
	return value;
}
