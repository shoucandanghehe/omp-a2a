import { build } from "esbuild";

const result = await build({
	entryPoints: ["src/index.ts"],
	outfile: "dist/index.js",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["@deepseek-ai/*", "ws"],
	metafile: true,
});
if (
	Object.keys(result.metafile.inputs).some((path) =>
		/hub\/(store|client)|config-document/.test(path),
	)
)
	throw new Error("Unexpected Hub/config runtime in native plugin");
