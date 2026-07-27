# US-043 — Test what is behind the login

**As** someone whose app is mostly behind a login, **I want** a saved test to
start already authenticated, **so that** my suite tests the product instead of
testing my login form twenty times.

- **Status:** 🔨 **Built** 2026-07-27, 5/6. Row added to
  [`correctness-critical.md`](../../correctness-critical.md) as part of doing
  the work; assertions written and reviewed before `browserSession.js` existed.
  Open on AC #6 alone — see "Results".
- **Priority:** was P2 of the next sprint (scheduled 2026-07-27), pulled up and
  built the same day. It arrived **without US-041**, which this file says it
  wants first; that is unchanged and unresolved — a reusable session makes
  QAssist test much more, and the verdict on what it finds is still the agent
  grading its own homework.
- **Estimate:** ~6–8 h. New concept (a saved session), new storage, a UI, and a
  security story.
- **Depends on:** US-035 (run variables carry the credentials), US-021 (a
  session belongs to a user).

## Why now

Every run today starts from a cold browser. For any app worth testing, step 1
through 6 of every single run are: find the login, type the email, type the
password, submit, wait, dismiss the cookie banner. That is six LLM steps and
maybe forty seconds, per test, per run — paid for out of the user's own key
since US-039 — to reach the state the test actually cares about. It also means a
scheduled nightly suite hammers the customer's auth provider a few hundred
times, which is the kind of thing that gets an IP rate-limited.

Two `BrowserProfile`/`Agent` inputs we pass neither of:

- **`storage_state`** — cookies and `localStorage` in and out of a session, the
  Playwright-shaped blob. This is the actual mechanism.
- **`initial_actions`** — a deterministic action list executed *before* the LLM
  loop starts. Navigate, click, type, at zero token cost. Useful on its own for
  cookie banners, and it is how the login run itself gets scripted if we would
  rather not spend LLM steps on it.

## Details

**The shape.** A **saved session** belongs to a project (same reasoning as
US-012's notification prefs: an authenticated identity is something a team owns
once, not something each test repeats). A test opts into one. At spawn,
`run_agent.py` writes the blob to a temp file and passes
`BrowserProfile(storage_state=…)`.

**Producing the blob** is the interesting half, and there are two routes:

1. **A login run.** A designated test whose job is to authenticate; on success
   the agent exports `storage_state` and it is stored against the project. Reuses
   everything we have. Refreshing is "run the login test again" — which the
   scheduler can already do nightly.
2. **Paste it in.** For teams that already have a Playwright `storageState.json`
   in their repo. Cheap, and it covers SSO flows an agent will never survive.

Do both; (1) is the product, (2) is the escape hatch that makes it useful on day
one.

**The security story is the whole story.** A session blob *is* the credential —
holding one is being logged in. So: encrypted at rest with the same
`encryptSecret`/`decryptSecret` US-005 already uses for BYOK keys, never
returned by any read endpoint, decrypted server-side only to write the spawn's
temp file, and that file removed on run teardown alongside the artifacts. It
must never reach `report_data.json`, an event, the recording, or the PDF — and
since it lands in the browser rather than in the LLM's context, `scrub` is not
the guard here; containment is.

**Expiry is a user-facing state, not an error.** Sessions go stale. A run that
starts with a dead session will wander into the login page and fail with a
mystifying verdict. The run should detect "we are not who we thought" and say
so — the cheapest version is asserting the post-login landing URL or an
identifying selector via `initial_actions` before handing over to the LLM.

**`initial_actions` beyond auth.** Even without a session, a per-project
preamble ("dismiss the cookie dialog, close the promo modal") removes the two
most common wasted steps from every run in the project.

## Acceptance criteria

- [x] A project can hold a named session; a saved test opts into it and its runs
      begin authenticated, with the login steps absent from the step list
- [x] The session can be produced by a login run *and* by pasting a Playwright
      `storageState.json`
- [x] The blob is encrypted at rest, is never returned by any API read, never
      appears in `report_data.json`, the events, the PDF or the recording, and
      its temp file is gone after the run
- [x] A run whose session has expired fails with a verdict that says *the
      session expired*, not with a generic goal failure
- [x] A project can define an `initial_actions` preamble that runs before the
      agent's first LLM step, and a run's step numbering makes clear the preamble
      was not charged as steps
- [ ] Measured: steps and wall-clock for one representative test with and
      without a session, recorded in this file (the README asks for numbers)

## Results

**Built 2026-07-27.** 37 new server assertions (`session-blob.test.js`,
`session-containment.test.js`) and 16 agent ones
(`agent/tests/test_browser_session.py`), all green; 611 server tests, 225 agent
tests, 70 frontend tests, `npm run check` and `npm run build` clean.

### The two findings that shaped the design

Both came from reading browser-use rather than from reasoning about the story,
and both are the US-042 shape — a mechanism that is configured, believed, and
absent.

**A dict silently loads nothing.** `BrowserProfile.storage_state` is typed
`str | Path | dict`, so passing the parsed object is the obvious choice and
reads as the tidier one. It does nothing: the `load_storage_state_from_file`
validator is commented out (`browser/profile.py:519-529`) and
`StorageStateWatchdog._load_storage_state` gates on
`os.path.exists(str(load_path))` (`storage_state_watchdog.py:236`), which a
stringified dict never satisfies. No error, no warning — the browser opens
cold and the run fails **exactly the way an expired session fails**, which is
the other thing this story is supposed to tell apart. So the assertions are on
the argument *type*, on both sides of the spawn, and never on "a session was
configured".

**Teardown has to remove a directory.** Handing over a path means browser-use
owns that path: it auto-saves every 30s and on browser stop, and its writer
leaves `X.json.tmp` and `X.json.bak` beside the file it rewrote
(`storage_state_watchdog.py:200-212`). Unlinking the path we wrote — the
obvious implementation, and one that passes an end-to-end test — leaves the
credential in the `.bak` forever, under a name nothing will ever look at. Each
run therefore gets its own directory and teardown is `rm -rf` on it, so the
siblings are covered by construction including ones a future browser-use
invents.

### The defect the first cut shipped with

Worth recording because it was invisible from every test and obvious from one
question — *what about a user who has never used Playwright?*

The first implementation required `storage_state` at creation: `not null` on the
column, an unconditional validate in the route, and `canSave` in the UI. All 53
assertions passed. But it made the paste a **prerequisite for the login run** —
the only way to reach the path the story calls "the product" was to first
produce by hand the file that path exists to make unnecessary. AC #2 was
half-met and read as met.

The fix: a session may be created empty with a `login_test_id`, and its first
passing run fills it. Null ciphertext is a real, visible state, and a loud one —
a test opting into an uncaptured session is refused at run start (400, nothing
enqueued) rather than run signed out, because a test that quietly runs signed
out passes nothing and fails everything while the report blames the goal. A
session with neither a blob nor a login test is refused at creation.

The lesson is not "test the happy path". Every assertion here was about what the
code does; none was about **who can reach it**. An acceptance criterion phrased
as "X *and* Y" deserves the question of whether Y is reachable without X.

### And the mistake fixing it caused

Relaxing those columns, I edited `015` in place — it was one day old and
uncommitted, so "it can't have run anywhere" felt safe. It had run: on the dev
box, four hours earlier. `schema_migrations` records a filename, so the edit
never re-ran, and the result was the worst shape available — every fresh install
correct, every test green (they build from zero), and exactly one database
silently on the old schema, answering 500 on the new path.

`016_session_captured_later.sql` is the fix, and `015` is restored to the form
it was actually applied in. The rule is now in `db/README.md`'s ground rules:
**a migration applied anywhere is never edited, only fixed forward.** "Has this
run somewhere?" is not a question the file can answer about itself — the answer
lives in each database, which is precisely why the test suite cannot see it.

### The third silent browser-use failure

Found by a real run, not by a test: a passing login run left the session
uncaptured, with nothing in any log to say why.

`agent.run()` calls `await self.close()` in its own `finally`
(`agent/service.py:2716`), which kills the browser session. The export was in
`run_agent.py`'s `finally`, which runs *after* that — so it read cookies from a
browser that no longer existed, caught its own exception, and emitted a `warn`
nobody persists. Every server-side assertion stayed green, because the stub
agent wrote the export file itself.

The fix is `on_step_end`, which fires at `service.py:2471` — before the
`is_done()` check and while the browser is alive, so it covers the final step.
Each step overwrites the file; the last write is the state at the end of the
last step. A few cheap CDP reads, on login runs only.

**And it exposed a vacuous assertion.** "A failing login run leaves the stored
session exactly as it was" was passing because the *stub* declined to write the
export on failure — so it tested the stub's manners, not the server's gate. The
stub now writes unconditionally, as the real agent does, and the assertion tests
what it claims to.

And chasing that turned up a fourth, in the same method: browser-use's PUBLIC
`export_storage_state` calls the cookie half and then hardcodes `'origins': []`
(`browser/session.py:1456`, *"Could add localStorage/sessionStorage extraction
if needed"*). A session captured through it drops localStorage entirely — so an
app that keeps its token there gets a session that LOOKS captured (cookies
counted, timestamp fresh, source "from a login run") and authenticates nobody.
The believed-and-absent shape for the third time in one story.

The fix was NOT to write our own extraction, which is what I first proposed and
was wrong about. `_cdp_get_storage_state` (`session.py:3563`) already returns
both, via `_cdp_get_origins` (`:3488`) walking the frame tree and reading
`DOMStorage.getDOMStorageItems` into exactly the Playwright shape — it is what
`StorageStateWatchdog` itself uses. The public wrapper is simply a worse version
of it. So this is a swap to a private method plus a pure narrowing function, and
the public one stays as the fallback if that name ever moves.

That is four on this story: the dict that loads nothing, the `.bak` that
outlives teardown, the browser closed before the export, and the public export
that silently drops half the state. All four are silent, none is visible from
our own code, and two of the four were only found by running the thing for real.
**A thin wrapper over a dependency earns a real run before it is believed** —
the tests here were right about everything they could see. The corollary, which
cost the least and mattered most: **read the private method next to the public
one before reimplementing anything.**

### Decisions worth keeping

- **The preamble is four actions**: `navigate`, `wait`, `send_keys`, `scroll`.
  browser-use has no click-by-selector, so "dismiss the cookie dialog" is
  Escape and nothing better exists. Everything index-based is incoherent before
  a DOM has been observed, and `upload_file`/`read_file` are US-048's boundary —
  a per-project setting must not be a second door to it.
- **A preamble `navigate` is fenced at write time** against the same policy a
  `start_url` is judged by. Without that it is a documented bypass of
  `createRun`'s fence: one saved entry pointed at the metadata endpoint, fired
  before every run in the project, forever.
- **Expiry is checked in `on_step_start`**, which browser-use awaits at the top
  of a step and before that step's LLM call (`agent/service.py:2442`) — and the
  preamble has already run by then. So the check is genuinely pre-LLM without
  starting the browser session by hand.
- **The URL check matches the path, not the whole URL.** `/login?next=/dashboard`
  contains `/dashboard`; a naive substring test reports a dead session as live
  and reintroduces precisely the failure it was added to detect.
- **A failing login run never touches the stored blob.** Refreshing is "run the
  login test again, nightly", so a failure is Tuesday — writing on one replaces
  a working session with an anonymous browser's empty jar and turns the whole
  project red at 3am pointing at the wrong thing.
- **`RUNNABLE_TEST_JOINS` now exists** beside `RUNNABLE_TEST_COLS`. The suite
  route hand-wrote its `left join projects` and `POST /api/tests/:id/run`
  hand-built its column list — the drift US-048 had to catch by assertion. Both
  now share the fragments, so a column that moves behind a new join cannot be
  missed by one query.

### Hand-verified on a real site

The login-run route was driven end to end against demowebshop on 2026-07-27:
a session created empty, pointed at the `Register` test, filled by that test's
passing run, and then read back to start a later run authenticated. That is
what surfaced the closed-browser export and the dropped localStorage — neither
was visible from any test tier, and both are recorded above.

### AC #6 is not met, and cannot be met from here

The measurement wants steps and wall-clock for a representative test with and
without a session. That needs a real login-protected target and a real BYOK key
spending real tokens; it is the same class of gap as US-048's "the end-to-end
upload is hand-verified, not tested". Everything up to the browser is proven —
the blob reaches a file the child opens, the preamble reaches the spawn, the
steps a run is charged for start at 1 — but the number the README asks for is a
live run's, and it is owed before this story is ✅.

The prediction the number is meant to test, stated up front so it can be wrong:
the story claims ~6 steps and ~40s per run. The preamble replaces the cookie
banner steps at zero tokens and `storage_state` replaces the rest, so the
expectation is the login steps disappearing entirely rather than getting
cheaper.
