# US-044 — Say *why* it failed: network and console evidence

**As** the developer who gets the failure email at 3am, **I want** the report to
name the request that 500'd and the exception the page threw, **so that** I can
start debugging from the report instead of starting by reproducing it.

- **Status:** ✅ **Done** 2026-07-27, 6/6. Pulled into `sprint/current/` and
  built the same day it was scheduled, *ahead* of US-020 — see "What shipped".
- **Priority:** P2 of the next sprint (scheduled 2026-07-27).
- **Estimate:** ~5–6 h (CDP subscriptions, event plumbing, report section);
  more if HAR retention is included.
- **Depends on:** US-020 (report v2 owns the layout this lands in), US-026 (the
  activity list these attach to). **US-020 was not done first, and this shipped
  without it** — the dependency turned out to be softer than it read.

## Why now

A QAssist failure currently says the goal was not achieved and shows you
screenshots. That is a *symptom* report. The cause is almost always visible in
the browser at the moment of failure and we throw it away: a 500 from the API, a
CORS rejection, an uncaught `TypeError` that killed the submit handler, a
request that never came back.

This is the difference between a tool that tells you something is broken and a
tool that tells you what is broken — and nothing else in the roadmap provides
it. For CI (US-008) it is the difference between a red build you investigate and
a red build you re-run.

Two independent routes, and we are already positioned for the better one:

- **CDP directly.** `run_agent.py` already holds a live CDP client and a
  registered handler for the screencast (`screencast()`), and already re-targets
  when the agent switches tabs. Subscribing to `Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown` and `Network.responseReceived` on the same session
  is a small addition to machinery that exists and is understood.
- **`BrowserProfile.record_har_path` / `record_har_content` / `record_har_mode`**
  — a full HAR written to the run directory by the browser itself. Complete, and
  large. `traces_dir` (Playwright `trace.zip`: actions, DOM snapshots, screenshots)
  is the heavyweight cousin if time-travel debugging ever becomes the ask.

## Details

**Default to the summary, not the archive.** The always-on artifact should be
small and curated: failed requests (status ≥ 400 and network failures), console
`error`/`warn`, and uncaught exceptions — each stamped with the step number it
occurred during, so it hangs off US-026's activity list and US-020's step
section. A full HAR behind a per-run or per-project flag, subject to
`ARTIFACT_RETENTION_DAYS` like everything else in `runs/<id>/`.

**Volume control is the real design problem.** A chatty single-page app can emit
thousands of console lines and hundreds of requests per step. Whatever is
captured must be capped, deduplicated (`n× TypeError: …`) and truncated, decided
*in the agent* before it crosses stdout — the NDJSON pipe into Express is the
one thing in this architecture that must not back up, and the screencast
comment in `run_agent.py` already says so.

**Redaction applies.** Request URLs carry query strings, headers carry `Bearer`
and `Cookie`, bodies carry everything. Anything captured goes through `scrub`
with the run's `sensitive` dict, and headers/bodies are not captured at all
unless explicitly asked for. A test whose credentials arrive via US-035 secret
variables must not leak them into an artifact that is emailed as a PDF.

**Feeding it back to the agent is a separate question.** browser-use has
`include_recent_events` for exactly this, and a judge that can see the 500 will
write a much better `failure_reason` — but it also puts arbitrary page-authored
text into the model's context, so it is a deliberate second step, not a freebie.
Leave it out of tier 1 and revisit once US-041's judge is the verdict.

## Acceptance criteria

- [x] Failed requests (≥400 and transport failures) and console errors/uncaught
      exceptions are captured per run, each attributed to the step it occurred
      during
- [x] They appear in the run detail (History and `/runs/<id>`) and in the report,
      attached to the relevant step
- [x] Output is capped and deduplicated in the agent; a page emitting thousands
      of console lines per step does not stall the NDJSON pipe or bloat
      `report_data.json` — measure and record the cap's effect
- [x] Captured URLs and messages pass through `scrub`; a secret variable's value
      never reaches an event, `report_data.json` or the PDF
- [x] Full HAR capture is opt-in, lands in `runs/<id>/`, and is pruned by
      `ARTIFACT_RETENTION_DAYS` with the rest
- [x] A run against a deliberately broken fixture page produces a report whose
      diagnostics section names the failing request — proven against a fixture,
      not a real site

## What shipped

**`agent/diagnostics.py`** is the whole of the capping and redaction: a
`Diagnostics` buffer with `set_step` / `request` / `console` / `exception` /
`drain`, plus the two CDP formatters and a bounded `PendingRequests`.
`run_agent.py` gained `diagnostics_watch`, a loop shaped like `screencast` that
subscribes to `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`,
`Network.requestWillBeSent`, `Network.responseReceived` and
`Network.loadingFailed`, re-arming when the agent switches tabs. Findings cross
stdout as one `{"type":"diagnostics"}` event per step boundary; the server
flattens them in `diagnosticsOf` into `report_data.json` and onto
`GET /api/runs/:id/steps`. `Diagnostics.jsx` renders them in the run detail (both
layouts, and live off the relay on `/runs/<id>`), and `make_report.py` gives them
a page of their own.

**It shipped ahead of US-020, and the dependency was softer than it read.** The
premise was that report v2 owns the layout this lands in. What it actually owns
is the *execution log*, and evidence does not need to live inside one: each
finding carries its step number, so a section grouped under `Step N` headings
reads correctly on its own and folds into the log later with no data change. The
run detail needed nothing new either — US-026's step list was already step-keyed.
Worth remembering as a general shape: **a "depends on" that is really "would look
nicer alongside" costs a sprint if nobody checks which it is.**

### Four subtleties, and the assertion set that caught them

Raised as assertion-first under the CLAUDE.md rule (redaction *and* volume
control in one buffer) and reviewed before `diagnostics.py` was written.

- **Scrub before truncate.** Truncating first splits a secret longer than the
  limit, so `scrub` no longer matches the whole value and the surviving prefix
  ships — into a PDF that US-012 emails. An implementation with this bug passes
  every "is the secret gone" test written against a short message, which is what
  makes it worth an assertion that deliberately straddles the boundary.
- **The dedupe key must be built from the scrubbed text.** Keying on raw text
  keeps the value in the buffer even when the emitted entry is clean, *and* makes
  two lines differing only inside a secret look distinct — so the step's cap is
  spent on cardinality that only the secret invented.
- **The per-step budget must reset on `set_step`.** A per-run cap wearing a
  per-step cap's clothes passes any single-step test, then burns itself on a
  chatty step 1 and records nothing for the step that failed — the only step this
  story exists to explain.
- **`dropped` is a running total, not a delta.** Every event carries the tally so
  far, so the server takes the maximum. Summing multiplies it by the step count
  and the report then claims a clean page lost 40 findings.

`Network.loadingFailed` also turned out to carry a requestId and an `errorText`
but **no URL** — that only ever arrives on `requestWillBeSent`. So "the request
that never came back" is unnameable without correlating the two, which is what
`PendingRequests` does, bounded to 500 because it sits on the hot path of every
request an SPA makes. Cancelled requests and `ERR_ABORTED` are dropped at the
handler: every navigation aborts what was in flight, and counting those would
spend the step's budget on page transitions.

### The cap's effect (AC #3)

60-step runs, console + request findings, measured against `Diagnostics` directly.
"Distinct" is the adversarial case — every line different, so deduplication
cannot help and only the cap can:

| Load per step | Entries kept | Dropped | `report_data.json` | CPU |
|---|---|---|---|---|
| 2 distinct | 240 | 0 | 34 KB | 0.7 ms |
| 50 distinct | 600 | 5,400 | 84 KB | 8 ms |
| 1,000 distinct | 600 | 119,400 | 84 KB | 165 ms |
| 1,000 repeated | 120 | 0 | 17 KB | 140 ms |
| **1,000 distinct, cap removed** | **120,000** | 0 | **17 MB** | 201 ms |

The last row is the story: without the cap a chatty SPA writes a 17 MB
`report_data.json` and pushes 120,000 entries through the NDJSON pipe. With it,
the ceiling is `5 × 3 kinds × QA_MAX_STEPS` — 900 entries, ~126 KB — reached
identically whether the page emitted 50 lines a step or 1,000, and it costs a
sixth of a second of CPU across an entire run. That flat 84 KB across two orders
of magnitude of load is what makes a second, server-side ceiling unnecessary.

### The HAR, and the one promise not made

Opt-in per run (`"har": true`) or per instance (`CAPTURE_HAR=1`), written by
Chromium itself with `record_har_content: omit` and `record_har_mode: minimal`,
so no header or body is recorded. It lands in `runs/<id>/network.har`, is served
by `GET /api/runs/:id/network.har`, and `retention.js` prunes it with the rest of
the directory (asserted, not assumed).

**`scrub` never sees it.** The browser writes the file, so a secret in a query
string appears verbatim — which is precisely why it is off by default, why it is
a download rather than something the report embeds or an email attaches, and why
`docs/api.md` and `.env.example` carry a warning about it rather than a promise.
AC #4's claim is scoped to events, `report_data.json` and the PDF, and the HAR is
deliberately outside it.

### Testing

- `agent/tests/test_diagnostics.py` — the reviewed assertion set (the scrub/
  truncate ordering pair, the dedupe key, a JSON canary over the whole drained
  payload, the per-step reset, per-kind budgets, repeats counting past the cap,
  `dropped` monotonic across steps, every capture path surviving junk), plus
  test-alongside cases for the CDP formatters and `PendingRequests`.
- `server/test/diagnostics-evidence.test.js` — `dropped` as max not sum, both
  read paths agreeing, a pre-US-044 report file reading as empty rather than
  throwing, the HAR's opt-in proven on the flag reaching the **child**, tenant
  scoping, and the real retention sweep taking the file.
- `agent/tests/test_report_diagnostics.py` — AC #6, asserted on `build_html`
  from `fixtures/broken_page_report_data.json` so it stays hermetic; also that
  page-authored text cannot inject markup into our own renderer.
- `frontend/src/Diagnostics.test.jsx` — grouping order, the two tag tones, the
  block's absence on a quiet run, and one request for steps and evidence
  together.

`fixtures/broken-page.html` is the live leg: a page carrying a 404 stylesheet, a
404 script, an unresolvable host, a 500 on submit and an uncaught `TypeError`,
none of which a screenshot shows. Its header holds the command to run against it.
**Not yet run end-to-end against a real browser** — like US-048's upload, that
needs a live Chromium, so step attribution (the assumption that
`register_new_step_callback` fires *before* the step's actions execute) is
reasoned from the existing `next_goal` emission rather than observed.

### Deliberately not done

- **Feeding the evidence back to the agent.** browser-use's
  `include_recent_events` would let the judge see the 500 and write a much better
  `failure_reason`, but it also puts arbitrary page-authored text into the
  model's context. Still a deliberate second step; revisit once US-041's judge
  owns the verdict.
- **A `has_har` column.** The file's presence on disk is what the download route
  reads. A column would be a migration for a debugging escape hatch, and a second
  copy of a fact that can disagree with the filesystem.
- **The live Run view (`RunView.jsx`).** The events reach it — it just ignores
  them. `/runs/<id>` shows them live, which is where a run in flight is watched
  in detail; the Run stage is already busy with the frame.
