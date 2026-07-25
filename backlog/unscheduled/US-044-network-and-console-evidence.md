# US-044 — Say *why* it failed: network and console evidence

**As** the developer who gets the failure email at 3am, **I want** the report to
name the request that 500'd and the exception the page threw, **so that** I can
start debugging from the report instead of starting by reproducing it.

- **Status:** 📋 Planned.
- **Priority:** P2 among the unscheduled work.
- **Estimate:** ~5–6 h (CDP subscriptions, event plumbing, report section);
  more if HAR retention is included.
- **Depends on:** US-020 (report v2 owns the layout this lands in), US-026 (the
  activity list these attach to).

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

- [ ] Failed requests (≥400 and transport failures) and console errors/uncaught
      exceptions are captured per run, each attributed to the step it occurred
      during
- [ ] They appear in the run detail (History and `/runs/<id>`) and in the report,
      attached to the relevant step
- [ ] Output is capped and deduplicated in the agent; a page emitting thousands
      of console lines per step does not stall the NDJSON pipe or bloat
      `report_data.json` — measure and record the cap's effect
- [ ] Captured URLs and messages pass through `scrub`; a secret variable's value
      never reaches an event, `report_data.json` or the PDF
- [ ] Full HAR capture is opt-in, lands in `runs/<id>/`, and is pruned by
      `ARTIFACT_RETENTION_DAYS` with the rest
- [ ] A run against a deliberately broken fixture page produces a report whose
      diagnostics section names the failing request — proven against a fixture,
      not a real site
