# Contributing

Thanks for looking. This is a small extension with a few rules that are the
whole point of it, so most of what follows is about those rather than about
style.

## The rules that are the point

**Everything the web returns is data, never an instruction.** Retrieved text
reaches the model inside `<untrusted_evidence>`, `<untrusted_state>` and
`<untrusted_history>` regions with any nested delimiters stripped, and every
system prompt says those regions are not instructions. The loop's own research
state gets the same treatment, because it round-trips through disk and comes
back as something the model wrote. If you add a place where fetched text meets a
prompt, it goes through `untrusted()` and inside a region.

**The model cannot cite what it did not fetch.** `src/citations.ts` runs after
the report is written: links outside the gathered catalog are unlinked, numeric
citations are dropped, a model-authored "Sources" section is deleted, and the
real list is generated from what was actually collected. This is deterministic
on purpose — a prompt asking nicely is not a guarantee. Code fences are masked
first, so a report about HTTP APIs keeps its example URLs.

**The plan is the user's.** Approval names the plan's revision *and* its sha256,
so a plan that changed between the render you read and the key you pressed is
refused rather than quietly run. Do not add a path that starts research without
going through that gate in an interactive session.

**Nothing installs itself.** Detecting that SearXNG is missing is automatic;
starting a container is not, because it outlives the session. The mechanics live
in `src/provision.ts` and the consent lives in the card that calls them. Keep
them apart.

**A search query is public text.** `sanitizeQuery` refuses anything shaped like
an API key, a private key, a JWT, an email address or a card number, and a
`fetch` action may only name a URL the loop already gathered. Both are about the
same failure: a model helpfully pasting your context into somebody's search box.

Before opening a pull request, grep your diff for a place where model output
reaches the network or the filesystem without passing one of these.

## The module headers are the contract

Every file in `src/` opens with a comment saying what it is for, which rule it
implements, and usually which bug taught us the rule. That is where the design
lives — `src/ui/frame.ts` carries the card-width rule and the 240-column
terminal that produced it, `src/indicator.ts` carries the two rules a background
poll has to follow and the crash that taught them, and `src/engine.ts` carries
why the approved plan is a fallback rather than a script.

**If the behaviour changes, change the header in the same pass as the code.** A
patch that makes a module behave differently from the comment above it is
incomplete, however good the code is.

## Layout rules

The UI is built from `src/ui/frame.ts` and these hold everywhere:

- **A card is a card, not a column of the screen.** Width caps at
  `MAX_CARD_COLUMNS` and centres. A share of the terminal degenerates on a wide
  monitor; `OverlayOptions` has no `maxWidth`, so the cap is computed in columns
  per call.
- **Every framed line is exactly the card's width.** There are tests asserting
  this at three widths for each card. Body lines arrive already themed, so they
  are measured with `visibleWidth`, never with `.length`.
- **Count rows, do not estimate them.** Lay the fixed parts out, count them,
  give the rest to the scrolling part. A guessed chrome height is wrong the
  moment a question wraps to a second line.
- **Every message must fit the narrowest card it can appear on.** A warning
  clipped mid-sentence is a warning nobody can act on. There is a test.
- **No chords.** `ctrl+t` was the first design for start/stop and Pi binds it to
  `app.thinking.toggle`; `ctrl+s` is XOFF on many terminals; Pi leaves almost no
  `ctrl+<letter>` free. Anything reachable by Tab cannot be stolen by a
  keybinding.

## Adding a setting

One entry in `src/settings-fields.ts` and nothing in the UI — the card walks
that list. Give it a `group`, a `kind`, and a `help` line that says what it
actually does. Add its default to `DEFAULTS`, its bounds to `LIMITS` if it is a
number, and its environment variable to `ENV_VARS`. The three-layer resolution
(environment, then file, then default) and the `env` tag come for free.

## What "done" means here

A claim is made only when it was **observed**. Several paths here cannot be
driven headlessly — the plan card, the hub, the settings screen and the entry
renderer all need a real TUI — so those are verified by rendering them to a
string and asserting the layout, plus a run in the terminal. An honest "the
keyboard path is unexercised" is a perfectly good note; a tick that was never
run is not.

`npm run check` — typecheck plus the suite — must be green before you send
anything.

## Development

```bash
npm install
npm run check      # tsc --noEmit, then node --test over the sources
```

TypeScript, loaded by Pi through jiti. **There is no build step**, which has
consequences worth knowing before you spend an afternoon on them:

- **No constructor parameter properties, and no `enum`.** `node --test` strips
  types rather than compiling them, and those two constructs cannot be
  stripped. They typecheck and they load under jiti, so the failure appears
  only in the tests, and only as a confusing one.
- **Imports keep their `.ts` extension.** Type stripping requires the real
  path; a bare specifier resolves under `tsc` and fails at runtime.
- **Pin the pi packages in `devDependencies` to the version you actually run**
  (`pi --version`). `"*"` resolves to whatever npm has today, and its types
  drift from the runtime Pi loads — `ModelRegistry.completeSimple` exists in
  0.87 and does not in 0.85, which is exactly the kind of thing that typechecks
  and then throws.

Tabs, not spaces.

## Testing conventions

Nothing in the suite touches the network, a model, or a container:

- **Search and fetch are injected.** `EngineOptions.tools` replaces them, so the
  loop's fallbacks — duplicate query, unparseable decision, `finish` before any
  evidence — are ordinary tests.
- **The model is a scripted caller** keyed on its system prompt, with an
  `asThinking` flag that puts every reply in the thinking block instead. That
  one flag is the regression test for a real failure: a thinking model reasoned
  its way to the plan and left the content part empty.
- **The container engine is a fake** that records what it was asked, which is
  how "a running container is reused, a stopped one is started, only a missing
  one is created" is a test rather than a pile of stray containers.

When you fix a bug, the test comment should say what the bug *was*. Several in
here read like little stories, and that is on purpose: they are the reason the
rule exists.
