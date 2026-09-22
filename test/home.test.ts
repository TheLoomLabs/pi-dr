import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { statusLine, toggleLabel, type SearchStatus } from "../src/status.ts";
import { MAX_CARD_COLUMNS, MIN_CARD_COLUMNS } from "../src/ui/frame.ts";
import { HomeCard, type HomeAction } from "../src/ui/home-card.ts";
import { stopContainer, type Runner } from "../src/provision.ts";
import type { Run } from "../src/types.ts";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

function status(overrides: Partial<SearchStatus> = {}): SearchStatus {
	return {
		url: "http://localhost:8890",
		answering: true,
		needsJson: false,
		detail: "",
		container: "running",
		engine: "docker",
		ours: true,
		...overrides,
	};
}

function run(question: string, runStatus = "completed", sources = 3): Run {
	return { id: question, question, status: runStatus, sources: Array.from({ length: sources }) } as unknown as Run;
}

const RUNS = [run("first question"), run("second question"), run("third question", "failed", 0)];

test("the status line separates answering from merely running", () => {
	assert.equal(statusLine(status()).token, "success");
	// A container that is up but has not loaded its engines yet is not "up".
	assert.equal(statusLine(status({ answering: false })).token, "warning");
	assert.match(statusLine(status({ answering: false })).text, /not answering yet/);
	assert.match(statusLine(status({ answering: false, needsJson: true })).text, /JSON API off/);
	assert.match(statusLine(status({ answering: false, container: "exited" })).text, /stopped/);
	assert.match(statusLine(status({ answering: false, container: "missing" })).text, /not installed/);
});

test("stopping is never offered for an instance we did not start", () => {
	// Somebody else's server is theirs to manage.
	assert.deepEqual(toggleLabel(status({ ours: false })), { action: "none", label: "external instance" });
	assert.equal(toggleLabel(status({ engine: undefined })).action, "none");
	assert.equal(toggleLabel(status()).action, "stop");
	assert.equal(toggleLabel(status({ container: "exited", answering: false })).action, "start");
	assert.equal(toggleLabel(status({ container: "missing", answering: false })).label, "install");
});

test("stopContainer stops but never removes the container", async () => {
	const calls: string[] = [];
	const runner: Runner = {
		async run(command, args) {
			calls.push(`${command} ${args.join(" ")}`);
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	const result = await stopContainer(runner, "docker", new AbortController().signal, "box");

	assert.equal(result.ok, true);
	assert.deepEqual(calls, ["docker stop box"]);
	assert.equal(calls.some((call) => call.includes(" rm")), false);
});

test("the hub renders a card of exactly the width it was given", () => {
	const card = new HomeCard(theme, RUNS, "a question");
	card.setStatus(status());
	for (const width of [MIN_CARD_COLUMNS, 60, MAX_CARD_COLUMNS]) {
		for (const line of card.render(width, 20)) assert.equal(visibleWidth(line), width);
	}
});

test("enter researches what was typed, and refuses to research nothing", () => {
	const card = new HomeCard(theme, RUNS, "");
	let action: HomeAction | undefined;
	card.onAction = (value) => {
		action = value;
	};

	card.handleInput("\r");
	assert.equal(action, undefined);
	assert.match(card.render(MAX_CARD_COLUMNS, 20).join("\n"), /Type a question first/);

	card.handleInput("z");
	card.handleInput("\r");
	assert.deepEqual(action, { kind: "research", question: "z" });
});

test("tab reaches the buttons, which is what a chord could not do", () => {
	// ctrl+t was the first design: Pi binds it to app.thinking.toggle, so the
	// overlay never saw the key. Nothing reachable by Tab can be stolen.
	const card = new HomeCard(theme, RUNS, "");
	card.setStatus(status());
	let action: HomeAction | undefined;
	card.onAction = (value) => {
		action = value;
	};

	card.handleInput("\u0014"); // ctrl+t: no longer meaningful
	assert.equal(action, undefined);

	card.handleInput("\t");
	card.handleInput("\r");
	assert.deepEqual(action, { kind: "toggle" });

	card.handleInput("\u001b[C"); // right: the next button
	card.handleInput("\r");
	assert.deepEqual(action, { kind: "settings", question: "" });
});

test("escape leaves the buttons before it closes the card", () => {
	const card = new HomeCard(theme, RUNS, "");
	card.setStatus(status());
	let closed = false;
	card.onClose = () => {
		closed = true;
	};

	card.handleInput("\t");
	card.handleInput("\u001b");
	assert.equal(closed, false, "first escape returns to the question");
	card.handleInput("\u001b");
	assert.equal(closed, true);
});

test("a detour through settings keeps the half-typed question", () => {
	const card = new HomeCard(theme, RUNS, "");
	let action: HomeAction | undefined;
	card.onAction = (value) => {
		action = value;
	};
	card.setStatus(status());
	card.handleInput("z");
	card.handleInput("\t");
	card.handleInput("\u001b[C");
	card.handleInput("\r");
	assert.deepEqual(action, { kind: "settings", question: "z" });
});

test("the history works like a shell's, and keeps the half-typed draft", () => {
	const card = new HomeCard(theme, RUNS, "");
	let action: HomeAction | undefined;
	card.onAction = (value) => {
		action = value;
	};

	card.handleInput("h");
	card.handleInput("i");
	card.handleInput("\u001b[A"); // up: most recent
	card.handleInput("\u001b[A"); // up: the one before
	card.handleInput("\u001b[B"); // down
	card.handleInput("\r");
	assert.deepEqual(action, { kind: "research", question: "first question" });

	// All the way back down returns what was being typed.
	const second = new HomeCard(theme, RUNS, "");
	second.onAction = (value) => {
		action = value;
	};
	second.handleInput("h");
	second.handleInput("\u001b[A");
	second.handleInput("\u001b[B");
	second.handleInput("\r");
	assert.deepEqual(action, { kind: "research", question: "h" });
});

test("typing leaves the history rather than silently editing it", () => {
	const card = new HomeCard(theme, RUNS, "");
	let action: HomeAction | undefined;
	card.onAction = (value) => {
		action = value;
	};
	card.handleInput("\u001b[A");
	card.handleInput("!");
	card.handleInput("\r");
	assert.deepEqual(action, { kind: "research", question: "first question!" });
	assert.equal(RUNS[0]!.question, "first question");
});

test("a busy card ignores input, so a keypress cannot start a second pull", () => {
	const card = new HomeCard(theme, RUNS, "q");
	let action: HomeAction | undefined;
	card.onAction = (value) => {
		action = value;
	};
	card.setBusy("pulling the image");
	card.handleInput("\r");
	card.handleInput("\u0014");
	assert.equal(action, undefined);
});

test("the button says what it will do, and greys out when it cannot", () => {
	const running = new HomeCard(theme, RUNS, "");
	running.setStatus(status());
	assert.match(running.render(MAX_CARD_COLUMNS, 20).join("\n"), /\[ Stop search \]/);

	const stopped = new HomeCard(theme, RUNS, "");
	stopped.setStatus(status({ container: "exited", answering: false }));
	assert.match(stopped.render(MAX_CARD_COLUMNS, 20).join("\n"), /\[ Start search \]/);

	// Somebody else's instance is theirs to manage: the button is disabled and
	// pressing it explains why rather than doing nothing.
	const external = new HomeCard(theme, RUNS, "");
	external.setStatus(status({ ours: false }));
	let action: HomeAction | undefined;
	external.onAction = (value) => {
		action = value;
	};
	external.handleInput("\t");
	external.handleInput("\r");
	assert.equal(action, undefined);
	assert.match(external.render(MAX_CARD_COLUMNS, 20).join("\n"), /not ours to start or stop/);
});

test("the history shrinks to fit a short terminal instead of overflowing", () => {
	const many = Array.from({ length: 40 }, (_, i) => run(`question ${i}`));
	const card = new HomeCard(theme, many, "");
	card.setStatus(status());
	assert.ok(card.render(MAX_CARD_COLUMNS, 14).length <= 14);
	assert.ok(card.render(MAX_CARD_COLUMNS, 40).length <= 40);
});

test("every message fits the narrowest card it can appear on", () => {
	// A warning clipped mid-sentence is a warning nobody can act on.
	const cases: (() => HomeCard)[] = [
		() => {
			const card = new HomeCard(theme, RUNS, "");
			card.setStatus(status({ ours: false }));
			card.handleInput("\t");
			card.handleInput("\r");
			return card;
		},
		() => {
			const card = new HomeCard(theme, RUNS, "");
			card.setStatus(status({ engine: undefined }));
			card.handleInput("\t");
			card.handleInput("\r");
			return card;
		},
		() => {
			const card = new HomeCard(theme, RUNS, "");
			card.setStatus(status());
			card.handleInput("\r");
			return card;
		},
	];
	for (const make of cases) {
		const text = make().render(MIN_CARD_COLUMNS, 20).join("\n");
		assert.doesNotMatch(text, /…\s*│$/m, "a message was clipped");
	}
});
