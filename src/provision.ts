import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SEARXNG_PORT } from "./config.ts";

/**
 * Bringing a SearXNG up, when the user asks for one.
 *
 * Deliberately not automatic. Starting a container is a change to the machine
 * that outlives the session, and an extension that quietly does it the first
 * time a command runs is one you cannot trust with the next thing. So the
 * mechanics live here, as plain functions, and the consent lives in the card
 * that calls them.
 *
 * The container engine is injected so the rules that matter — we never run
 * `docker run` without having checked for an existing container first, and we
 * never reuse one we did not create — are unit tests rather than something you
 * find out by having two of them.
 */

export const CONTAINER_NAME = "pi-deep-research-searxng";
export const IMAGE = "docker.io/searxng/searxng:latest";

export interface Runner {
	run(command: string, args: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The real one. Never throws on a non-zero exit — that is data, not a fault. */
export const systemRunner: Runner = {
	run(command, args, signal) {
		return new Promise((resolve) => {
			execFile(command, args, { signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
				const code =
					error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
						? ((error as unknown as { code: number }).code ?? 1)
						: error
							? 1
							: 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			});
		});
	},
};

export type ContainerState = "missing" | "exited" | "running";

/** Which engine this machine has, preferring the one that is actually up. */
export async function findEngine(runner: Runner, signal: AbortSignal): Promise<string | undefined> {
	for (const engine of ["docker", "podman"]) {
		const probe = await runner.run(engine, ["info", "--format", "{{.ServerVersion}}"], signal);
		if (probe.code === 0) return engine;
	}
	return undefined;
}

export async function containerState(
	runner: Runner,
	engine: string,
	signal: AbortSignal,
	name = CONTAINER_NAME,
): Promise<ContainerState> {
	const result = await runner.run(
		engine,
		["ps", "--all", "--filter", `name=^${name}$`, "--format", "{{.State}}"],
		signal,
	);
	const state = result.stdout.trim().toLowerCase();
	if (!state) return "missing";
	return state.startsWith("run") ? "running" : "exited";
}

/** Where the instance's config lives, beside Pi's own. */
export function configDir(): string {
	return join(getAgentDir(), "searxng");
}

/**
 * The one override that matters, plus the two that stop a fresh instance
 * refusing us.
 *
 * `use_default_settings` means this file is a patch, not a fork: SearXNG keeps
 * shipping engine updates and we keep the three lines we actually care about.
 * The JSON format is the whole reason — a default install serves HTML only and
 * answers 403 to the API. The limiter goes off because a local instance being
 * rate-limited by its own user is nothing but a confusing failure.
 */
export function settingsYaml(secret: string): string {
	return `# Written by pi-deep-research. Safe to edit; only these keys are ours.
use_default_settings: true

server:
  secret_key: "${secret}"
  limiter: false

search:
  formats:
    - html
    - json
`;
}

export async function writeInstanceSettings(dir = configDir()): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "settings.yml");
	await writeFile(path, settingsYaml(randomBytes(32).toString("hex")), "utf8");
	return path;
}

export function runArgs(port: number, dir: string, name = CONTAINER_NAME): string[] {
	return [
		"run",
		"--detach",
		"--name",
		name,
		"--restart",
		"unless-stopped",
		// Loopback only. This instance is for one machine's agent, and a search
		// proxy reachable from the network is somebody else's open relay.
		"--publish",
		`127.0.0.1:${port}:8080`,
		"--volume",
		`${dir}:/etc/searxng`,
		"--env",
		`SEARXNG_BASE_URL=http://localhost:${port}/`,
		IMAGE,
	];
}

export interface ProvisionResult {
	ok: boolean;
	url: string;
	detail: string;
}

export type ProvisionStep = (message: string) => void;

/**
 * Start an instance, reusing whatever is already there.
 *
 * Three cases, in the order they have to be checked: a container of ours that
 * is already running is simply the answer; one that exists but has stopped is
 * started rather than replaced, because its `settings.yml` and its secret key
 * are the ones we wrote; only when there is none does anything get created.
 */
export async function provisionSearxng(
	options: {
		runner?: Runner;
		port?: number;
		dir?: string;
		name?: string;
		signal: AbortSignal;
		onStep?: ProvisionStep;
	},
): Promise<ProvisionResult> {
	const runner = options.runner ?? systemRunner;
	const port = options.port ?? DEFAULT_SEARXNG_PORT;
	const dir = options.dir ?? configDir();
	const name = options.name ?? CONTAINER_NAME;
	const url = `http://localhost:${port}`;
	const step = options.onStep ?? (() => {});

	const engine = await findEngine(runner, options.signal);
	if (!engine) {
		return {
			ok: false,
			url,
			detail: "No working Docker or Podman was found. Install one, or point at an instance you already run.",
		};
	}

	const state = await containerState(runner, engine, options.signal, name);
	if (state === "running") {
		step(`${name} is already running`);
		return { ok: true, url, detail: `Reused the running ${name} container.` };
	}
	if (state === "exited") {
		step(`starting the existing ${name} container`);
		const started = await runner.run(engine, ["start", name], options.signal);
		if (started.code !== 0) {
			return { ok: false, url, detail: `${engine} start failed: ${firstLine(started.stderr)}` };
		}
		return { ok: true, url, detail: `Started the existing ${name} container.` };
	}

	step("writing settings.yml (JSON API on, limiter off)");
	await writeInstanceSettings(dir);

	// Pulled as its own step so the wait has something to say: a cold pull is
	// hundreds of megabytes and `run` would otherwise sit silent for minutes.
	step(`pulling ${IMAGE}`);
	const pulled = await runner.run(engine, ["pull", IMAGE], options.signal);
	if (pulled.code !== 0) {
		return { ok: false, url, detail: `${engine} pull failed: ${firstLine(pulled.stderr)}` };
	}

	step(`starting ${name} on 127.0.0.1:${port}`);
	const created = await runner.run(engine, runArgs(port, dir, name), options.signal);
	if (created.code !== 0) {
		return { ok: false, url, detail: `${engine} run failed: ${firstLine(created.stderr)}` };
	}

	return { ok: true, url, detail: `Started ${name} on ${url}.` };
}

function firstLine(text: string): string {
	return (text.trim().split("\n")[0] ?? "unknown error").slice(0, 200);
}

/** Stop a container we started. Never `rm`: its settings.yml and its secret key
 *  are the ones we wrote, and starting it again should be instant. */
export async function stopContainer(
	runner: Runner,
	engine: string,
	signal: AbortSignal,
	name = CONTAINER_NAME,
): Promise<{ ok: boolean; detail: string }> {
	const result = await runner.run(engine, ["stop", name], signal);
	return result.code === 0
		? { ok: true, detail: `Stopped ${name}.` }
		: { ok: false, detail: `${engine} stop failed: ${firstLine(result.stderr)}` };
}
