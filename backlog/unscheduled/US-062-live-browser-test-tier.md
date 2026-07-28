# US-062 — A test tier that drives a real browser

**As** the maintainer, **I want** a tier of tests that opens a real Chromium,
**so that** the claims three shipped stories had to leave resting on "someone
watched it work" become claims that a merge re-proves.

- **Status:** 📋 Planned — extracted 2026-07-28 from the three closed stories
  that each hit the same wall and each said so in the same words. This is the
  missing tier they name, and US-042 already assigned it: *"a preview-
  environment check with a real 302 … belongs to whoever next touches this
  surface."* Nobody has.
- **Priority:** P2 — it is not a feature, but it is the reason two
  correctness-critical stories closed at 5/6 and "proven by hand", and the
  count grows with every story that touches the browser.
- **Estimate:** ~1 day for the harness and the first two cases; the third
  (agent-driven) is a separate decision, see below.
- **Depends on:** US-034 (the testing practice this extends), US-042, US-043,
  US-048 (the three unproven claims it exists to close)

## The three claims

| story | what is unproven | why |
|---|---|---|
| [US-042](../sprint/current/done/US-042-agent-navigation-confinement.md) AC #2 | a permitted host 302s into a blocked one and `SecurityWatchdog.on_NavigationCompleteEvent` refuses it | *"needs a live Chromium and a real redirect — no tier of ours can reach it"* |
| [US-048](../sprint/current/done/US-048-file-upload-in-test-flows.md) last AC | browser-use drives a live `<input type=file>` | *"needs a Chromium and a funded key and so belongs to the same tier as US-042's redirect criterion"* |
| [US-043](../sprint/current/done/US-043-reusable-authenticated-sessions.md) | `storageState` round-trips — export from a closed browser, localStorage included | the closed-browser export and the dropped localStorage were found by hand: *"neither was visible from any test tier"* |

Everything *beneath* each hop is asserted. US-042 proves the three env vars that
arm the watchdog reach the child; US-048 proves the whitelist is built, scoped to
the owning project and named in the task; US-043 proves the blob is encrypted,
stored and loaded. In all three the assertion stops one layer short of the
browser, and in all three the bug that actually shipped lived in that layer —
US-043's dropped localStorage is the proof that the gap is not theoretical.

## What the tiers are today

- `cd server && npm test` — `node --test` + supertest, in-process, **agent and
  report stubbed**. Never spawns Python.
- `scheduler-postgres.test.js` — the same suite against real Postgres, for SQL
  whose correctness pg-mem cannot judge.
- `cd agent && .venv/bin/python -m pytest` — pure stdlib units. `docs/testing.md`
  is explicit: no browser, no IMAP, no network.
- `cd frontend && npm test` — Vitest, jsdom.

Nothing in that list launches Chromium. That is a deliberate property worth
keeping — the fast tiers stay fast and hermetic — which is why this is a *new*
tier and not a change to an existing one.

## The insight that makes it cheap

**Two of the three claims do not need an LLM.** `SecurityWatchdog` is attached
by `BrowserSession`, not by `Agent` (`browser_use/browser/session.py:1703`), so
the fence can be armed and a real 302 refused with a `BrowserSession` and no
model call at all. `storageState` export and load are likewise session-level.
Point both at a local fixture server — a few routes that redirect, set a cookie,
write localStorage and accept an upload — and the tier is deterministic, free,
and offline.

Only US-048's criterion genuinely needs the agent: the claim is that
*browser-use, driven by a model,* attaches a whitelisted file. That needs a
funded key and is non-deterministic, and it should be a separate, explicitly
opt-in case — not the thing that decides whether the tier can run at all.

So: **build the free half first.** It closes two of three claims, runs anywhere,
and can be a required check. The funded half is a flag on top.

## Details

- Lives with the agent (`agent/`), because what it drives is the Python side:
  `pytest`, marked so the default `pytest` invocation still runs pure units only
  and `docs/testing.md`'s promise stays true. A `-m browser` selection, or a
  separate directory — pick one and say which in `docs/testing.md`.
- Chromium is already in the image; Playwright is already a dependency via
  browser-use. The new cost is the fixture server (stdlib `http.server` is
  enough) and the fixtures, not new deps.
- **CI placement.** CI runs on a PR into `dev`, a push to `staging` or `main`,
  and in the release workflow (US-055). The free half belongs there. The funded
  half must never be a merge gate — it spends money and can fail for reasons
  that are not a regression.
- **Do not turn this into an e2e suite.** The scope is the hops the fast tiers
  structurally cannot reach. A browser test of something already covered by
  supertest is a slower duplicate of a test that already exists, and the way
  this tier stops being run is by getting slow.

## Acceptance criteria

- [ ] A permitted host that 302s into a blocked one is refused, asserted against
      a real redirect — closing US-042 AC #2, with that story's file updated to
      say where it is now proven
- [ ] A `storageState` exported after the browser closed contains the cookies
      **and** the localStorage a fixture page wrote, and a session loaded from it
      starts authenticated — closing US-043's hand-verified findings
- [ ] The free half needs no API key and no network beyond loopback, and runs in
      CI on a PR into `dev`
- [ ] The default `pytest` invocation still runs pure units only; how to run the
      browser tier is in `docs/testing.md`
- [ ] The funded, agent-driven upload case exists behind an explicit opt-in, is
      not a merge gate, and closing US-048's last criterion is stated as
      depending on it having been run
- [ ] Runtime of the free half is recorded here; if it is not fast enough to be
      a required check, say so rather than making it optional quietly

## Notes

- The honest framing US-048 used is the one to keep: *"worth being precise about
  which claims rest on a test and which rest on someone watching it work."* This
  story does not exist because the hand verification was wrong — all three were
  right. It exists because none of them re-runs.
- US-059's tier 3 (social login through the fence) lands in exactly this gap
  too, and cannot be proven without a provider account. Not in scope; noted so
  the tier is designed knowing a third consumer is coming.
