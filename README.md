# pi-deep-research

[github.com/TheLoomLabs/pi-dr](https://github.com/TheLoomLabs/pi-dr)

Interactive deep research for the [Pi coding agent](https://github.com/earendil-works/pi).

You give it a question. It drafts a research plan, **shows you the plan and lets you rewrite it**,
and only then goes and does the research — searching a self-hosted SearXNG instance, reading the
best pages, auditing its own evidence, and writing a report whose every citation is a source it
actually fetched.

## How it works

Four separate model calls, each with its own system prompt:

| Phase | What it produces |
|---|---|
| **Plan** | `{title, steps:[{title, query}]}` — strict JSON, 1–12 steps |
| **Decide** (loop) | one action per turn: `search`, `fetch`, or `finish`, plus a rolling research state |
| **Audit** | an evidence-to-claim audit: what is supported, what is inference, what contradicts |
| **Report** | Markdown after a boundary marker, citing only the source catalog |

The approved plan is **guidance, not a script**. The decision loop may reorder it, chase a
follow-up, or stop early. The plan's second job is to be the fallback: when a decision is
unparseable, duplicated, or refused, the next unused plan query runs instead of burning the turn.

Design notes on where this came from: [`docs/unsloth-deep-research.md`](docs/unsloth-deep-research.md).

## Requirements

A SearXNG instance with its JSON API enabled — and if you have not got one,
`/research` offers to start one the first time you run it:

```
╭─ Set up search ───────────────────────────────────────────╮
│ No SearXNG is answering.                                  │
│ http://localhost:8890                                     │
│                                                           │
│ ▌ Start one with Docker                                   │
│ ▌   searxng/searxng, bound to localhost, JSON API on      │
│   Point at an instance you already run                    │
│     enter its URL; it is checked before anything is saved │
│   Not now                                                 │
│     nothing is changed                                    │
│                                                           │
│ ↑↓ select · ⏎ choose · esc cancel                         │
╰───────────────────────────────────────────────────────────╯
```

Detection is automatic; starting anything is not. A container outlives the
session, so it takes a keypress — and the URL you end up with is saved to
`~/.pi/agent/deep-research.json`, so the question is asked once.

The Docker route writes a `settings.yml` that enables the JSON API (a default
install serves HTML only and answers `403`), turns the limiter off, publishes to
`127.0.0.1` only, and reuses a container it has already created rather than
stacking up a second one.

Port **8890**, not 8888 — a machine running a coding agent is exactly the
machine likely to have Unsloth Studio on 8888 already.

Running your own instead? Add this to its `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

## Install

```bash
pi install https://github.com/TheLoomLabs/pi-dr
```

That reads the `pi.extensions` entry in `package.json` and adds the repo to your
pi settings. `pi list` shows what is installed, and
`pi remove https://github.com/TheLoomLabs/pi-dr` takes it out again.

From a local checkout:

```bash
git clone https://github.com/TheLoomLabs/pi-dr
pi install ./pi-dr
```

Or, for a single session without installing anything:

```bash
pi -e /path/to/pi-dr/src/index.ts
```

Dropping a clone into `~/.pi/agent/extensions/` does **not** work:
auto-discovery looks for `index.ts` at the directory root, and this extension's
entry point is `src/index.ts`. `pi install` is the supported path — it reads the
entry point out of `package.json`.

Restart pi after installing; `/research` appears once the extension loads.

## Use

`/research` opens the hub:

```
╭─ Deep research ──────────────────────────────────────────────────────────╮
│ What should I research?                                                  │
│ ▌ how does zig comptime work▏                                            │
│                                                                          │
│ ● SearXNG up · http://localhost:8890                             ^t stop │
│                                                                          │
│ Recent                                                                   │
│   ✓ what is the Zig programming language comptime feature?    16 sources │
│   ✓ what is SearXNG and who maintains it?                     40 sources │
│   × best budget used cars in Croatia under 10000 EUR with relia…  failed │
│                                                                          │
│ ⏎ research · ↑↓ recent · ^t start/stop search · esc close                │
╰──────────────────────────────────────────────────────────────────────────╯
```

Type a question and press Enter. `↑↓` walks previous questions like shell
history — research questions are long and usually get retyped with one word
changed — and whatever you had half-typed comes back when you walk to the
bottom. `^t` starts or stops the SearXNG container without leaving the editor;
it is `^t` and not `^s` because `^s` is XOFF on a good many terminals.

The status dot separates *answering* from merely *running*: a container that is
up but has not loaded its engines yet says so rather than claiming to be ready.
Stopping is never offered for an instance this extension did not start.

`/research <question>` skips the hub and goes straight to planning.

Then the plan appears, and nothing is searched until you approve it:

```
╭─ Research plan ──────────────────────────────────────────────────────────╮
│ Croatia Budget Car Research Plan                                 5 steps │
│                                                                          │
│ ▌  1  Top Rated Used Cars Under 10k EUR                                  │
│ ▌     best used cars to buy in Croatia under 10000 euros 2026            │
│    2  Popular Models on Croatian Marketplaces                            │
│       site:njuskalo.hr OR site:index.hr auto used car price under 10000… │
│                                                                          │
│ ↑↓ select · ⏎ approve · e query · t title · a add · d delete             │
╰──────────────────────────────────────────────────────────────────────────╯
```

Edit it, press Enter, and the loop runs with live progress. Escape stops it; the
run is on disk either way.

The model can also call it as a tool (`deep_research`). In an interactive
session you still get the approval gate; headless runs (`-p`, JSON, RPC) run the
drafted plan.

| Command | Does |
|---|---|
| `/research` | Open the hub |
| `/research <question>` | Skip the hub, plan straight away |
| `/research-runs` | List saved runs above the editor |

Runs and reports are written to `.pi/research/<id>.json` and `.pi/research/<id>.md`.

### Where the report goes

A finished report lands in the transcript as a custom entry — durable, rendered,
and deliberately **not** part of the model's context. What the model gets is a
one-line pointer to the file on disk.

This is on purpose. Injecting the whole report as a queued message meant the
next thing typed — `hi` — arrived with fourteen thousand characters of research
attached, and the model answered the research instead of the greeting. A pointer
is harmless whenever it lands, and the agent can read the file when you ask
about it.

The `deep_research` tool is different: there the model asked for the report, so
it gets the report (capped, with the tail left on disk).

### Cost accounting

A run is a dozen-plus model calls that never touch Pi's agent loop, so Pi cannot
see them. The tool returns their combined `Usage`, which is what puts them in the
footer, `/session` and the session totals; `/research` reports the same figure in
its completion notice and stores it on the run.

## Configuration

Everything is editable in the UI — `/research` → Tab → `Settings`:

```
╭─ Deep research settings ─────────────────────────────────────────────────╮
│ Search                                                                   │
│ ▌ SearXNG URL           http://localhost:8890                            │
│   Authorization header  none                                             │
│   Categories            general                                          │
│   Language              hr                                          env  │
│   Safe search           off                                              │
│ Sources                                                                  │
│   Allowed domains       any                                              │
│   Blocked domains       youtube.com, pinterest.com                       │
│   Sources per search    8                                                │
│   Sources per run       40                                               │
│   Pages read per search 2                                                │
│ Run                                                                      │
│   Actions per run       6                                                │
│   Search timeout        30s                                              │
│                                                                          │
│ Which instance to query. Changing this away from the default means the   │
│ start/stop control is no longer yours.                                   │
│                                                                          │
│ ↑↓ select · ⏎ edit · r default · esc back                                │
╰──────────────────────────────────────────────────────────────────────────╯
```

Numbers and choices change in place with `←→`; text and domain lists open an
inline field on `⏎`. `r` restores a field's default. Changes are written as they
are made — a settings screen with a save button is one where half the changes
are lost to Escape. The selected field's help line explains what it actually
does.

Settings live in `~/.pi/agent/deep-research.json`.

### Three layers

Highest first: **environment**, then the **settings file**, then the
**defaults**. A field the environment is overriding shows its live value with an
`env` tag and refuses to be edited — writing to the file would change nothing
you can see, which is the worst thing a settings screen can do. Each field
resolves on its own, so one environment variable does not drag the rest of the
file along with it.

| Setting | Env override | Default |
|---|---|---|
| SearXNG URL | `PI_DR_SEARXNG_URL` | `http://localhost:8890` |
| Authorization header | `PI_DR_SEARXNG_AUTH` | none |
| Categories | `PI_DR_CATEGORIES` | `general` |
| Language | `PI_DR_LANGUAGE` | `en` |
| Safe search | `PI_DR_SAFESEARCH` | off |
| Allowed domains | `PI_DR_ALLOWED_DOMAINS` | any |
| Blocked domains | `PI_DR_BLOCKED_DOMAINS` | none |
| Sources per search | `PI_DR_SOURCES_PER_STEP` | `8` |
| Sources per run | `PI_DR_MAX_SOURCES` | `40` |
| Pages read per search | `PI_DR_SCRAPE_PER_STEP` | `2` |
| Actions per run | `PI_DR_MAX_STEPS` | `12` |
| Search timeout | `PI_DR_TOOL_TIMEOUT_MS` | `30000` |

The domain lists are the interesting ones. They are enforced twice — in the
prompts *and* in code at collection and after redirects — so an allow list of
`docs.python.org` gives you a run that physically cannot cite anything else.

The auth header is never printed back: the screen shows `set (24 characters)`,
because a settings screen is the one place a screenshot reliably catches a
credential.

## Untrusted input

Everything a web page returns is data, never instruction. Retrieved text is wrapped in
`<untrusted_evidence>` / `<untrusted_state>` / `<untrusted_history>` regions with any nested
delimiters stripped, and every prompt says those regions are not instructions. The loop's own
research state is treated the same way, because it round-trips through disk.

Search queries pass a sanitizer that refuses anything carrying an API key, a private key, a JWT,
an email address, or a card-shaped number. A `fetch` action may only name a URL the loop already
gathered.

Citations are validated deterministically after the model writes: links to anything outside the
fetched catalog are unlinked, numeric citations are dropped, a model-authored "Sources" section
is deleted, and the real source list is generated from what was fetched. Code fences and inline
code are masked first, so a report about HTTP APIs keeps its example URLs intact.

## Tests

```bash
npm test
```

92 tests, no network, no model and no container: search and fetch are injected, the model is a
scripted caller keyed on system prompt, and the container engine is a fake that records what it
was asked. The card layouts are asserted on — every framed line is exactly the card's width, at
every terminal size.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). It is mostly about the four rules that
are the point of this extension — untrusted input, citations the model cannot
invent, the plan being yours to approve, and nothing installing itself — rather
than about style.

## Licence

MIT. See [LICENSE](LICENSE).
