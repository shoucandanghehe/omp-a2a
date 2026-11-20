import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { AcpClient, type AcpPermission } from "../src/acp/client.ts";

const fakeAgent = fileURLToPath(
	new URL("./fixtures/acp-agent.cjs", import.meta.url),
);

function open(
	scenario: string,
	requestPermission?: (
		request: AcpPermission,
		signal: AbortSignal,
	) => Promise<string | undefined>,
) {
	return AcpClient.start({
		command: process.execPath,
		args: [fakeAgent, scenario],
		cwd: process.cwd(),
		requestPermission,
	});
}

test("ACP collects only assistant text from its session over split stdio frames", async () => {
	const client = await open("basic");
	try {
		expect(await client.prompt("test")).toEqual({
			text: "答🧪",
			stopReason: "end_turn",
		});
	} finally {
		await client.close();
	}
	expect((await client.terminated).kind).toBe("closed");
});

test("ACP permission defaults to reject and does not select persistent grants", async () => {
	for (const handler of [undefined, async () => "always"]) {
		const client = await open("permission", handler);
		try {
			expect((await client.prompt("test")).text).toBe("deny");
		} finally {
			await client.close();
		}
	}
});

test("ACP selects only an explicit one-time permission after showing details", async () => {
	const client = await open("permission", async (request) => {
		expect(request.title).toBe("Read a file");
		expect(request.detail).toContain("/tmp/demo");
		return request.options.find((option) => option.kind === "allow_once")?.id;
	});
	try {
		expect((await client.prompt("test")).text).toBe("allow");
	} finally {
		await client.close();
	}
});

test("ACP cancellation clears pending permission and permits a later prompt", async () => {
	const requested = Promise.withResolvers<AbortSignal>();
	const client = await open("cancel", (_request, signal) => {
		requested.resolve(signal);
		return new Promise((resolve) =>
			signal.addEventListener("abort", () => resolve("allow"), { once: true }),
		);
	});
	try {
		const abort = new AbortController();
		const result = client.prompt("first", abort.signal);
		const outcome = result.catch((error: unknown) => error);
		const permissionSignal = await requested.promise;
		await expect(client.prompt("parallel")).rejects.toMatchObject({
			kind: "busy",
		});
		abort.abort();
		expect(await outcome).toMatchObject({ kind: "cancelled" });
		expect(permissionSignal.aborted).toBe(true);
		expect((await client.prompt("second")).text).toBe("答🧪");
	} finally {
		await client.close();
	}
});

test("ACP rejects unsupported protocol versions", async () => {
	await expect(open("version")).rejects.toMatchObject({ kind: "protocol" });
});

test("ACP fails closed on an overlong frame without a newline", async () => {
	const client = await open("oversize");
	try {
		await expect(client.prompt("test")).rejects.toMatchObject({
			kind: "protocol",
		});
	} finally {
		await client.close();
	}
});

test("ACP reports an idle agent exit", async () => {
	const client = await open("exit");
	try {
		expect((await client.terminated).kind).toBe("transport");
		await expect(client.prompt("test")).rejects.toMatchObject({
			kind: "transport",
		});
	} finally {
		await client.close();
	}
});

test("ACP sparse tool permission resolves the latest same-session operation by ID", async () => {
	const client = await open("sparse", async (request) => {
		expect(request.title).toBe("Read a file");
		expect(request.detail).toContain("Tool: read_file");
		expect(request.detail).toContain("/tmp/latest");
		expect(request.detail).not.toContain("/tmp/old");
		expect(request.detail).not.toContain("/tmp/unrelated");
		return "allow";
	});
	try {
		expect((await client.prompt("test")).text).toBe("allow");
	} finally {
		await client.close();
	}
});

test("ACP denies sparse, oversized and stale tool permission without offering approval", async () => {
	for (const scenario of ["missing", "oversize-tool", "previous-turn"]) {
		let calls = 0;
		const client = await open(scenario, async () => {
			calls++;
			return "allow";
		});
		try {
			const initialCalls = scenario === "previous-turn" ? 1 : 0;
			if (initialCalls)
				expect((await client.prompt("first")).text).toBe("allow");
			expect((await client.prompt("test")).text).toBe("deny");
			expect(calls).toBe(initialCalls);
		} finally {
			await client.close();
		}
	}
});

test("ACP invalidates a permission choice if the operation changes during approval", async () => {
	const client = await open("changed", async (request) => {
		expect(request.detail).toContain("/tmp/latest");
		await Bun.sleep(25);
		return "allow";
	});
	try {
		expect((await client.prompt("test")).text).toBe("deny");
	} finally {
		await client.close();
	}
});
