import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTAINER_NAME,
	containerState,
	findEngine,
	IMAGE,
	provisionSearxng,
	runArgs,
	settingsYaml,
	type Runner,
} from "../src/provision.ts";

/** A container engine that answers from a script and records what it was asked. */
function fakeRunner(script: Record<string, { code?: number; stdout?: string; stderr?: string }>): {
	runner: Runner;
	calls: string[];
} {
	const calls: string[] = [];
	const runner: Runner = {
		async run(command, args) {
			const key = `${command} ${args[0]}`;
			calls.push(`${command} ${args.join(" ")}`);
			const reply = script[key] ?? { code: 0 };
			return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
		},
	};
	return { runner, calls };
}

const signal = new AbortController().signal;

test("the engine is whichever of docker or podman actually answers", async () => {
	const { runner } = fakeRunner({ "docker info": { code: 1 }, "podman info": { code: 0 } });
	assert.equal(await findEngine(runner, signal), "podman");

	const { runner: none } = fakeRunner({ "docker info": { code: 1 }, "podman info": { code: 127 } });
	assert.equal(await findEngine(none, signal), undefined);
});

test("container state reads running, exited and missing apart", async () => {
	for (const [stdout, expected] of [["running\n", "running"], ["exited\n", "exited"], ["", "missing"]] as const) {
		const { runner } = fakeRunner({ "docker ps": { stdout } });
		assert.equal(await containerState(runner, "docker", signal), expected);
	}
});

test("a running container of ours is reused, never recreated", async () => {
	const { runner, calls } = fakeRunner({ "docker info": { code: 0 }, "docker ps": { stdout: "running" } });
	const result = await provisionSearxng({ runner, signal });

	assert.equal(result.ok, true);
	assert.match(result.detail, /Reused/);
	assert.equal(calls.some((call) => call.includes(" run ")), false);
	assert.equal(calls.some((call) => call.startsWith("docker pull")), false);
});

test("a stopped container is started, not replaced", async () => {
	// Its settings.yml and its secret key are the ones we wrote; recreating it
	// would throw both away.
	const { runner, calls } = fakeRunner({ "docker info": { code: 0 }, "docker ps": { stdout: "exited" } });
	const result = await provisionSearxng({ runner, signal });

	assert.equal(result.ok, true);
	assert.deepEqual(calls.filter((call) => call.startsWith("docker start")), [`docker start ${CONTAINER_NAME}`]);
	assert.equal(calls.some((call) => call.includes(" run ")), false);
});

test("only a missing container is created, and the pull is its own step", async () => {
	const { runner, calls } = fakeRunner({ "docker info": { code: 0 }, "docker ps": { stdout: "" } });
	const steps: string[] = [];
	const result = await provisionSearxng({
		runner,
		signal,
		dir: "/tmp/pi-dr-test-settings",
		onStep: (line) => steps.push(line),
	});

	assert.equal(result.ok, true);
	assert.ok(calls.some((call) => call === `docker pull ${IMAGE}`));
	assert.ok(calls.some((call) => call.includes("docker run --detach")));
	assert.ok(steps.some((step) => step.includes("pulling")));
});

test("a failed pull reports the engine's own first line and starts nothing", async () => {
	const { runner, calls } = fakeRunner({
		"docker info": { code: 0 },
		"docker ps": { stdout: "" },
		"docker pull": { code: 1, stderr: "no space left on device\nsecond line" },
	});
	const result = await provisionSearxng({ runner, signal, dir: "/tmp/pi-dr-test-settings" });

	assert.equal(result.ok, false);
	assert.match(result.detail, /no space left on device/);
	assert.doesNotMatch(result.detail, /second line/);
	assert.equal(calls.some((call) => call.includes(" run ")), false);
});

test("with no container engine nothing is attempted", async () => {
	const { runner, calls } = fakeRunner({ "docker info": { code: 1 }, "podman info": { code: 1 } });
	const result = await provisionSearxng({ runner, signal });

	assert.equal(result.ok, false);
	assert.match(result.detail, /Docker or Podman/);
	assert.deepEqual(calls, ["docker info --format {{.ServerVersion}}", "podman info --format {{.ServerVersion}}"]);
});

test("the container is published to loopback only", () => {
	// A search proxy reachable from the network is somebody else's open relay.
	const args = runArgs(8890, "/etc/somewhere");
	assert.ok(args.includes("127.0.0.1:8890:8080"));
	assert.equal(args.some((arg) => arg === "8890:8080"), false);
});

test("the written settings enable the JSON API, which is the whole point", () => {
	const yaml = settingsYaml("deadbeef");
	assert.match(yaml, /use_default_settings: true/);
	assert.match(yaml, /formats:\n {4}- html\n {4}- json/);
	assert.match(yaml, /secret_key: "deadbeef"/);
	assert.match(yaml, /limiter: false/);
});
