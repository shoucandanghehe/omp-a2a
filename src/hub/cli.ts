#!/usr/bin/env bun
import { defaultDataDir } from "../paths";
import {
	startHubServer,
	type StartHubServerOptions,
} from "./server";

type HubCliEnvironment = Record<string, string | undefined>;

export function parseHubCliOptions(
	args: string[],
	environment: HubCliEnvironment = process.env,
): StartHubServerOptions {
	let portFlag: string | undefined;
	let hostFlag: string | undefined;
	let dataDirFlag: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (
			argument === "--port" ||
			argument === "--host" ||
			argument === "--data-dir"
		) {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`missing value for ${argument}`);
			}
			if (argument === "--port") portFlag = value;
			else if (argument === "--host") hostFlag = value;
			else dataDirFlag = value;
			index++;
		} else if (argument?.startsWith("--port=")) {
			portFlag = argument.slice("--port=".length);
		} else if (argument?.startsWith("--host=")) {
			hostFlag = argument.slice("--host=".length);
		} else if (argument?.startsWith("--data-dir=")) {
			dataDirFlag = argument.slice("--data-dir=".length);
		} else {
			throw new Error(`unknown Hub argument: ${argument}`);
		}
	}

	if (portFlag !== undefined && !portFlag.trim()) {
		throw new Error("empty value for --port");
	}
	if (hostFlag !== undefined && !hostFlag.trim()) {
		throw new Error("empty value for --host");
	}
	if (dataDirFlag !== undefined && !dataDirFlag.trim()) {
		throw new Error("empty value for --data-dir");
	}

	const portValue =
		portFlag ?? environment.OMP_A2A_HUB_PORT?.trim() ?? "4173";
	const port = Number(portValue);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`invalid Hub port: ${portValue}`);
	}
	const host =
		hostFlag?.trim() || environment.OMP_A2A_HUB_HOST?.trim() || "127.0.0.1";
	const dataDir =
		dataDirFlag?.trim() ||
		environment.OMP_A2A_HUB_DATA_DIR?.trim() ||
		defaultDataDir();
	return { host, port, dataDir };
}

async function run(): Promise<void> {
	const options = parseHubCliOptions(process.argv.slice(2));
	const handle = await startHubServer(options);
	console.log(
		JSON.stringify({
			ok: true,
			service: "omp-a2a-hub",
			listenUrl: handle.listenUrl,
			protocolVersion: handle.protocolVersion,
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
	await Promise.withResolvers<void>().promise;
}

if (import.meta.main) await run();
