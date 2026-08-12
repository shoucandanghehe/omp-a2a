import * as fs from "node:fs";
import { type OmpErrors, type as omptype } from "@oh-my-pi/omptype";
import { parseWithSchema } from "./config-document";
import { localConfigCandidates } from "./paths";
import type { A2aLocalConfig } from "./types";
import { AGENT_NAME_RE, PROJECT_NAME_RE } from "./types";

const trimmedNonBlankString = omptype("string")
	.pipe((value) => value.trim())
	.narrow(
		(value, context) =>
			value.length > 0 || context.mustBe("a non-blank string"),
	);

const projectName = trimmedNonBlankString.narrow(
	(value, context) =>
		PROJECT_NAME_RE.test(value) ||
		context.mustBe("a valid Project name using [a-zA-Z0-9._-], max 64"),
);

const agentName = trimmedNonBlankString.narrow(
	(value, context) =>
		AGENT_NAME_RE.test(value) ||
		context.mustBe(
			"a valid Agent name using Unicode letters, numbers, marks, or ._-, max 32 characters",
		),
);

const localConfigSchema = omptype({
	project: projectName,
	name: agentName,
	"hubUrl?": trimmedNonBlankString,
	autoConnect: omptype("boolean").default(true),
	"+": "reject",
});

function formatLocalConfigErrors(errors: OmpErrors): string | undefined {
	for (const error of errors) {
		const field = error.path[0];
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

/** Load first existing local a2a config under cwd, or null if absent. */
export function loadLocalConfig(cwd: string): A2aLocalConfig | null {
	for (const file of localConfigCandidates(cwd)) {
		if (!fs.existsSync(file)) continue;
		return parseWithSchema(file, localConfigSchema, {
			label: "a2a config",
			formatErrors: formatLocalConfigErrors,
		});
	}
	return null;
}
