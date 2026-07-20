import { expect, test } from "bun:test";
import a2aExtension from "../src/extension";

function schemaStub() {
	return {
		optional() {
			return this;
		},
	};
}

test("the model-facing tool contract forbids polling for replies", () => {
	let description = "";
	const zod = {
		string: schemaStub,
		boolean: schemaStub,
		array: schemaStub,
		enum: schemaStub,
		object: schemaStub,
	};

	a2aExtension({
		zod,
		setLabel() {},
		on() {},
		registerCommand() {},
		registerTool(tool: { description: string }) {
			description = tool.description;
		},
	} as never);

	expect(description).toContain("Never wait, sleep, or poll inbox for a reply after send");
});
