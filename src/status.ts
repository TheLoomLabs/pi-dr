import { defaultSearxngUrl, loadConfig } from "./config.ts";
import { containerState, findEngine, systemRunner, type ContainerState, type Runner } from "./provision.ts";
import { probeSearxng } from "./searxng.ts";

/**
 * One answer to "can I research right now, and what can I do about it".
 *
 * Deliberately two questions kept apart. *Answering* is the only one that
 * matters to a run; the container is only how this extension can help. An
 * instance somebody else runs answers without a container, and a container of
 * ours can be running a minute before it answers its first search — reporting
 * either as the other is how a status line starts lying.
 */
export interface SearchStatus {
	url: string;
	/** The JSON API returned results just now. */
	answering: boolean;
	/** It replied, but not with JSON — a settings fix, not a missing server. */
	needsJson: boolean;
	detail: string;
	/** Undefined when there is no container engine to ask. */
	container?: ContainerState;
	engine?: string;
	/** Is the configured URL the container we would start? Only then are the
	 *  start and stop controls ours to offer. */
	ours: boolean;
}

export async function readStatus(signal: AbortSignal, runner: Runner = systemRunner): Promise<SearchStatus> {
	const config = loadConfig();
	const probe = await probeSearxng(config, AbortSignal.any([signal, AbortSignal.timeout(8_000)]));
	const engine = await findEngine(runner, signal);
	const container = engine ? await containerState(runner, engine, signal) : undefined;

	return {
		url: config.searxngUrl,
		answering: probe.ok,
		needsJson: probe.needsJson,
		detail: probe.detail,
		...(container !== undefined ? { container } : {}),
		...(engine !== undefined ? { engine } : {}),
		ours: config.searxngUrl === defaultSearxngUrl(),
	};
}

/** The one line the hub prints, and the word on the button beside it. */
export function statusLine(status: SearchStatus): { token: "success" | "warning" | "error"; text: string } {
	if (status.answering) return { token: "success", text: `up · ${status.url}` };
	if (status.needsJson) return { token: "warning", text: `JSON API off · ${status.url}` };
	if (status.container === "running") {
		return { token: "warning", text: `container up, not answering yet · ${status.url}` };
	}
	if (status.container === "exited") return { token: "error", text: `stopped · ${status.url}` };
	if (status.container === "missing" && status.engine) {
		return { token: "error", text: `not installed · ${status.url}` };
	}
	return { token: "error", text: `unreachable · ${status.url}` };
}

/** What ctrl+t would do, or why it would do nothing. */
export function toggleLabel(status: SearchStatus): { action: "start" | "stop" | "none"; label: string } {
	if (!status.engine) return { action: "none", label: "no docker" };
	// Never offer to stop something we did not start: the URL points somewhere
	// else, and that instance is somebody's to manage, not ours.
	if (!status.ours) return { action: "none", label: "external instance" };
	if (status.container === "running") return { action: "stop", label: "stop" };
	return { action: "start", label: status.container === "exited" ? "start" : "install" };
}
