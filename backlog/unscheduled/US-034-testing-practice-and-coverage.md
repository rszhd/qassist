# US-034 — Testing practice: selective TDD and the coverage still owed

**As a** developer building this app with an AI pair, **I want** a written
testing practice and the test surfaces we deliberately skipped filled in, **so
that** correctness-critical logic is specified before it's implemented and the
agent core stops being the one untested part of the product.

- **Status:** 🔨 In progress — spun out 2026-07-24 when the three test *gaps*
  were closed (agent `email_codes` under pytest, frontend `status.js` under
  Vitest, the "red test is fixed in the code" rule in CLAUDE.md). This story is
  the work those three did **not** cover. Landed so far: `scrub` lifted to
  `agent/redact.py` + `test_redact.py`; report formatters split to
  `agent/report_format.py` + `test_report_format.py`; verdict path covered by
  `server/test/verdict.test.js` replaying recorded `fixtures/*.ndjson` through
  the real engine; frontend mount smoke tests (`frontend/src/App.test.jsx`,
  `RunDetail.test.jsx`) under jsdom + `@testing-library/react`; the selective-TDD
  practice is now a standing CLAUDE.md Workflow rule, written as a forward rule
  (assertion-first for correctness-critical pieces, with the duty to *flag* such
  a piece placed on Claude, since Harith won't always catch it); `mutmut` is
  wired for a repeatable agent mutation audit (`agent/setup.cfg`,
  `mutate_only_covered_lines` to skip the untested IMAP glue). All build items
  are done — `redact.py` leaves no survivors; the remaining survivors are
  equivalent mutants (`fmt_date` Z-replace, `generate_address` partition) plus a
  couple of honest gaps in `email_codes` helpers (`extract_code`'s 4-char lower
  bound, `_strip_html` flags) left as reported, not silently patched. What stays
  open is judgement, not code: keeping `backlog/correctness-critical.md` current
  and exercising the assertion-first habit on the next hard piece.
- **Priority:** P2 (unscheduled) — the suites exist and pass; this deepens them.
- **Estimate:** ~1 day for the coverage items; the practice itself is free.
- **Depends on:** nothing hard. The pytest and Vitest harnesses are already in
  place (`agent/pytest.ini`, `frontend` `npm test`).
- **Baseline (2026-07-24):** a manual red-first/mutation sweep over the two new
  suites killed 10/10 mutations — every seeded defect was caught by a test, so
  neither suite has a pass-no-matter-what test. That is *sensitivity*, not
  correctness of the expected values; see `docs/testing.md`.

## Design decisions

**Selective TDD, not red-green-refactor on everything.** The house style is
spec-driven (a `backlog/US-xxx` story is the contract) with tests written
alongside the feature in the same commit — good discipline, but the tests are
authored by the same agent as the code, so they can encode one misunderstanding
twice. The mitigation is *not* full TDD ceremony. It is: for the
correctness-critical, easy-to-get-subtly-wrong pieces — scheduler claim, slot
math, redaction, billing gates when they arrive — **Harith writes or tightens
the assertion first, reviews it, then the agent implements against it.** The
test becomes a spec the implementation can't quietly bend. CRUD and wiring stay
test-alongside. Capture this as a short paragraph in CLAUDE.md once the habit
has proven itself in practice, so we're not documenting an aspiration.

**Agent coverage still owed** (the browser-driving core remains untested; the
first layer only reached the pure-stdlib `email_codes.py`):
- `run_agent.py` `scrub()` — secret redaction, so wrong behaviour leaks
  credentials into emitted events. It is currently a **nested closure** over
  `sensitive`, so it isn't importable. Lift it to a module-level
  `scrub(text, sensitive)` (or a small class) and unit-test it: known value
  replaced with `<redacted:name>`, non-string passthrough, empty `sensitive`
  passthrough, a value appearing inside a URL. This is the highest-value item
  here — it's security logic with zero coverage.
- `make_report.py` formatters — `fmt_duration`, `fmt_elapsed`, `fmt_date`,
  `step_ok`, `esc`. Pure and edge-case-y (`step_ok`'s keyword heuristic
  especially). Importing the module pulls Playwright; either accept that in the
  agent venv or split the formatters into a dependency-free module the report
  imports.
- Verdict/judge logic and one **recorded-fixture run** — feed a canned NDJSON
  transcript through the pass/fail judging path without launching a browser, so
  the product's actual decision is exercised.

**Frontend component smoke test** ✅ landed 2026-07-24: `App.test.jsx` renders
the real shell in jsdom against a URL-routed `fetch` stub (health up → nav
shows; no DB → nav hidden), and `RunDetail.test.jsx` renders a canned run row
via the `liveSteps` path so it never fetches. Added `jsdom` +
`@testing-library/react`, scoped to the component tests with a per-file
`// @vitest-environment jsdom` docblock so `status.js`'s test stays DOM-free.
The one harness surprise was `window.matchMedia` (App's theme effect), stubbed
in the App test. A red-first sweep confirmed sensitivity: a component that
throws on mount fails the App tests, and a wrong verdict word fails RunDetail —
the "builds green but crashes on render" class the build itself can't see.

**Not in scope:** an end-to-end test that launches a real browser + LLM. Slow,
flaky, and costs tokens per run; the recorded-fixture approach above buys most
of the confidence without any of that.
