import { startHubServer } from "./server";

const args = process.argv.slice(2);
let port: number | undefined;
let host: string | undefined;
let publicUrl: string | undefined;
let dataDir: string | undefined;

for (let index = 0; index < args.length; index++) {
	const argument = args[index]!;
	const next = args[index + 1];
	if (argument === "--port" && next) {
		port = Number(next);
		index++;
	} else if (argument.startsWith("--port=")) {
		port = Number(argument.slice("--port=".length));
	} else if (argument === "--host" && next) {
		host = next;
		index++;
	} else if (argument.startsWith("--host=")) {
		host = argument.slice("--host=".length);
	} else if ((argument === "--public-url" || argument === "--publicUrl") && next) {
		publicUrl = next;
		index++;
	} else if (argument.startsWith("--public-url=") || argument.startsWith("--publicUrl=")) {
		publicUrl = argument.slice(argument.indexOf("=") + 1);
	} else if (argument === "--data-dir" && next) {
		dataDir = next;
		index++;
	} else if (argument.startsWith("--data-dir=")) {
		dataDir = argument.slice("--data-dir=".length);
	} else {
		throw new Error(`unknown or incomplete Hub argument: ${argument}`);
	}
}

const handle = await startHubServer({ port, host, publicUrl, dataDir });
console.log(
	JSON.stringify({
		ok: true,
		service: "omp-a2a-hub",
		host: host ?? process.env.OMP_A2A_HUB_HOST ?? "127.0.0.1",
		...handle.meta,
	}),
);

const shutdown = async (signal: string) => {
	console.error(`Hub shutting down on ${signal}`);
	try {
		await handle.stop();
	} finally {
		process.exit(0);
	}
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await new Promise(() => {});
