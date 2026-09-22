import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULTS, ENV_VARS, parseDomains, resolveSettings, values } from "../src/settings.ts";
import { adjust, FIELDS, format, parse } from "../src/settings-fields.ts";
import { configFrom } from "../src/config.ts";
import { MAX_CARD_COLUMNS, MIN_CARD_COLUMNS } from "../src/ui/frame.ts";
import { SettingsCard } from "../src/ui/settings-card.ts";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

const touched: string[] = [];
function setEnv(name: string, value: string): void {
	touched.push(name);
	process.env[name] = value;
}
afterEach(() => {
	for (const name of touched.splice(0)) delete process.env[name];
});

test("the environment wins, then the file, then the default", () => {
	assert.equal(resolveSettings({}).maxSteps.source, "default");
	assert.equal(resolveSettings({ maxSteps: 7 }).maxSteps.value, 7);
	assert.equal(resolveSettings({ maxSteps: 7 }).maxSteps.source, "file");

	setEnv(ENV_VARS.maxSteps, "3");
	const resolved = resolveSettings({ maxSteps: 7 });
	assert.equal(resolved.maxSteps.value, 3);
	assert.equal(resolved.maxSteps.source, "env");
	// One value from the environment must not drag the rest of the file with it.
	assert.equal(resolveSettings({ maxSteps: 7, maxSources: 11 }).maxSources.source, "file");
});

test("values out of range are clamped wherever they came from", () => {
	assert.equal(resolveSettings({ maxSteps: 9_000 }).maxSteps.value, 30);
	assert.equal(resolveSettings({ maxScrapePerStep: -4 }).maxScrapePerStep.value, 0);
	setEnv(ENV_VARS.maxSources, "99999");
	assert.equal(resolveSettings({}).maxSources.value, 200);
});

test("nonsense in the environment falls through rather than poisoning a run", () => {
	setEnv(ENV_VARS.maxSteps, "not a number");
	assert.equal(resolveSettings({ maxSteps: 5 }).maxSteps.value, 5);
});

test("domain lists are normalised however they are written", () => {
	assert.deepEqual(parseDomains(" Example.COM , .docs.example.com ,, "), [
		"example.com",
		"docs.example.com",
	]);
	setEnv(ENV_VARS.blockedDomains, "YouTube.com, x.com");
	assert.deepEqual(resolveSettings({}).blockedDomains.value, ["youtube.com", "x.com"]);
});

test("a saved setting reaches the run's config", () => {
	const config = configFrom(values(resolveSettings({ maxSourcesPerStep: 3, categories: "general,science" })));
	assert.equal(config.budgets.maxSourcesPerStep, 3);
	assert.equal(config.categories, "general,science");
	assert.equal(config.searxngUrl, DEFAULTS.searxngUrl);
});

test("a blank auth header is absent rather than empty", () => {
	assert.equal("searxngAuth" in configFrom(values(resolveSettings({}))), false);
	assert.equal(configFrom(values(resolveSettings({ searxngAuth: "Bearer x" }))).searxngAuth, "Bearer x");
});

test("numbers step within bounds and choices wrap", () => {
	const steps = FIELDS.find((f) => f.key === "maxSteps")!;
	assert.equal(adjust(steps, 30, 1), 30, "stops at its ceiling");
	assert.equal(adjust(steps, 1, -1), 1, "stops at its floor");

	const safe = FIELDS.find((f) => f.key === "safesearch")!;
	assert.equal(adjust(safe, 2, 1), 0, "wraps round");
	assert.equal(adjust(safe, 0, -1), 2);
});

test("typed values are validated before they are stored", () => {
	const url = FIELDS.find((f) => f.key === "searxngUrl")!;
	assert.equal(parse(url, "http://box:8890/").value, "http://box:8890");
	assert.match(parse(url, "box:8890").error ?? "", /http\(s\) URL/);

	const steps = FIELDS.find((f) => f.key === "maxSteps")!;
	assert.match(parse(steps, "99").error ?? "", /between 1 and 30/);
	assert.match(parse(steps, "abc").error ?? "", /not a number/);

	const language = FIELDS.find((f) => f.key === "language")!;
	assert.equal(parse(language, "en-GB").value, "en-GB");
	assert.match(parse(language, "english").error ?? "", /language code/);
});

test("the auth header is never printed back", () => {
	// A settings screen is the one place a screenshot reliably catches a secret.
	const auth = FIELDS.find((f) => f.key === "searxngAuth")!;
	const shown = format(auth, "Bearer super-secret-value");
	assert.doesNotMatch(shown, /super-secret/);
	assert.match(shown, /set \(25 characters\)/);
	assert.equal(format(auth, ""), "none");
});

test("empty lists read as their meaning, not as nothing", () => {
	assert.equal(format(FIELDS.find((f) => f.key === "allowedDomains")!, []), "any");
	assert.equal(format(FIELDS.find((f) => f.key === "blockedDomains")!, []), "none");
});

function card(stored = {}): SettingsCard {
	const resolved = resolveSettings(stored);
	return new SettingsCard(theme, resolved, values(resolved));
}

test("the settings card renders a card of exactly the width it was given", () => {
	for (const width of [MIN_CARD_COLUMNS, 60, MAX_CARD_COLUMNS]) {
		for (const line of card().render(width, 26)) assert.equal(visibleWidth(line), width);
	}
});

test("changing a value persists it immediately", () => {
	const written: Record<string, unknown>[] = [];
	const c = card();
	c.onChange = (update) => {
		written.push(update);
		return { ok: true };
	};
	c.handleInput("\u001b[C"); // right on the first field (a URL) does nothing
	assert.deepEqual(written, []);

	// Walk to a number field and step it.
	for (let i = 0; i < 7; i++) c.handleInput("\u001b[B");
	c.handleInput("\u001b[C");
	assert.equal(written.length, 1);
	assert.equal(c.values().maxSourcesPerStep, DEFAULTS.maxSourcesPerStep + 1);
});

test("a field the environment owns refuses to be edited, and says why", () => {
	setEnv(ENV_VARS.language, "hr");
	const c = card();
	let saved = 0;
	c.onChange = () => {
		saved++;
		return { ok: true };
	};
	for (let i = 0; i < 3; i++) c.handleInput("\u001b[B"); // to Language
	c.handleInput("\r");
	assert.equal(saved, 0);
	assert.match(c.render(MAX_CARD_COLUMNS, 26).join("\n"), /PI_DR_LANGUAGE is set/);
});

test("a failed write is reported rather than silently dropped", () => {
	const c = card();
	c.onChange = () => ({ ok: false, error: "read-only file system" });
	for (let i = 0; i < 7; i++) c.handleInput("\u001b[B");
	c.handleInput("\u001b[C");
	assert.match(c.render(MAX_CARD_COLUMNS, 26).join("\n"), /read-only file system/);
});

test("r restores the default for the selected field", () => {
	const c = card({ maxSteps: 3 });
	c.onChange = () => ({ ok: true });
	assert.equal(c.values().maxSteps, 3);
	for (let i = 0; i < 10; i++) c.handleInput("\u001b[B"); // to Actions per run
	c.handleInput("r");
	assert.equal(c.values().maxSteps, DEFAULTS.maxSteps);
});
