# US-033 — Live demo: a canned run that replays as if it were live

**As a** visitor who has not signed up, **I want** to press Run on a sample
test and watch a real session play out, **so that** I know what the product
does before deciding whether to pay for it — and **as the** operator, **I want**
that to cost me nothing per visitor.

- **Status:** 📋 Planned (next sprint, hosted tier — added 2026-07-23)
- **Priority:** P2 — not required to take payment, but it is the cheapest
  conversion work in the release and the only thing that answers "what does
  this actually look like?" without spending a browser slot or an API key.
- **Estimate:** ~1–2 days
- **Depends on:** US-006 (the recordings it replays already exist), US-026
  (`report_data.json` / the steps read path). **Not** blocked by US-021 or
  US-022 — but the CTA at the end of the demo has nowhere to point until
  US-022 exists, so ship it alongside billing rather than before.

## Background

A free trial costs real money: every trial run is a Chromium session on the
VPS, one of `MAX_CONCURRENT_SESSIONS=4` slots, and LLM tokens. With BYOK
(US-005) a visitor can't even try without pasting an OpenAI key first, which
is a wall in front of the thing they came to evaluate.

The replay is nearly free because **the live stage is already fed by an event
stream, not by the agent**. `runs.js` broadcasts `frame` / `step` / `status` /
`done` events over WS and the Run view renders whatever arrives. A demo run
does not need an agent, a browser, a queue slot or a token — it needs a
recorded event log played back with the original inter-event delays.

## Design

1. **Fixtures live outside `runs/`, checked into the repo.** Two reasons, both
   hard: `sweepArtifacts()` deletes *any* uuid-named directory under
   `ARTIFACTS_DIR` older than `ARTIFACT_RETENTION_DAYS` (`retention.js:44`), so
   a demo parked in `runs/<uuid>/` disappears after a week; and a fresh deploy
   with an empty volume must still have a working demo. Put them in `demo/<slug>/`
   — `events.ndjson`, `recording.mp4`, `report.pdf`, `step_*.png` — and treat
   the directory as source, not artifact.

2. **No DB row.** Demo runs must never appear in History, never count toward a
   pass rate, and never be prunable. `runs.trigger` is a CHECK constraint of
   `('ui','api','schedule','ci')` (`001_init.sql:104`) — the temptation is a
   migration adding `'demo'`, and it is the wrong move: a row is exactly the
   thing that leaks into every list endpoint and every future metric. Serve
   the demo from its own endpoints reading the fixture directory.

3. **Replay preserves the recorded timing, with a floor and a ceiling.** Each
   event carries its offset from run start; the replayer sleeps the difference.
   A real run is minutes long and a landing page gets seconds — **decide the
   compression while implementing**, and if the clock is sped up, say so on
   screen rather than quietly lying about how fast the product is.

4. **The visual is the recording, not the frames.** `broadcast()` keeps
   screencast frames live-only by design (`runs.js:72`) — they are never
   persisted, so there is nothing to replay. Rather than start persisting
   frames for every run to serve two demos, play the fixture's `recording.mp4`
   in the stage and fire the step events over it on their real offsets. If that
   proves unconvincing, the fallback is a one-off frame capture for the demo
   runs only — a recording script, not a change to the live run path.

5. **This is the one unauthenticated surface.** Every API and WS call takes a
   bearer token today. The demo routes are the exception and must be scoped
   like one: read-only, fixture-backed, no run creation, no test creation, and
   rate-limited per IP so the endpoint isn't a free bandwidth tap for the
   recordings. Do not solve this by handing the browser a real token.

6. **Env-gated, like billing.** `DEMO_MODE` unset = the demo doesn't exist:
   no route, no nav entry, no unauthenticated surface at all. Self-host
   default is off. Per `docs/repo-model.md` the code lives in this repo (a
   self-hoster demoing the tool to their own team is a plausible use), gated
   the same way `STRIPE_*` is.

7. **Honesty is the acceptance bar.** A replay presented as a live run is a
   fabricated record. It must carry a visible `Demo` badge in the stage and on
   the card, state that it is a previously recorded session, and not offer
   Edit or Re-run controls that would imply a real agent is reachable. The end
   of the replay is where the signup CTA goes.

8. **Record a pass and a failure.** Two or three fixtures, and at least one
   must fail. A demo where everything passes shows a UI; a demo where the
   agent catches a broken checkout shows the product. Pick targets that are
   safe to record against and stable enough to re-record — the replay never
   re-visits them, but a refresh in six months should be possible.

## Decisions to make while implementing

- **Replay over WS or SSE/HTTP?** Reusing the WS relay means the Run view
  needs no second code path; a separate demo socket means the relay stays a
  thing that only real runs touch. Prefer reuse if it doesn't drag auth into
  the socket handshake.
- **Where the demo lives in the URL space.** `/demo` as a route (US-030 made
  the frontend router-driven, and any non-`/api` path already serves
  `index.html`, so this is frontend-only) versus a separate marketing page.
- **Does a visitor pick the test, or is there one?** A list of sample tests
  they choose from is more convincing and costs one more fixture.
- **How the fixtures get made.** A script that runs a real test with
  `DEMO_CAPTURE=1` and writes `demo/<slug>/` is worth it if re-recording is
  ever expected; a by-hand copy of a `runs/<id>/` directory plus its event log
  is enough for the first two.

## Acceptance criteria

- [ ] With `DEMO_MODE` unset, no demo route, no demo endpoints, and no
      unauthenticated request succeeds anywhere — self-host is byte-for-byte
      unchanged
- [ ] With it set, a visitor with no token can open the demo, press Run, and
      watch steps and the recording play out in the real Run stage
- [ ] The replay spawns no Python process, takes no queue slot, and makes no
      LLM call (assert it in the test — this is the whole point of the story)
- [ ] Demo runs create no `runs` row: History, filters and any pass-rate
      number are unaffected before and after a demo is watched
- [ ] The demo is labelled as a recorded session everywhere it appears, and
      offers no control implying a live agent
- [ ] Fixtures survive a retention sweep and a fresh deploy with an empty
      `runs/` volume
- [ ] Demo endpoints are rate-limited per IP
- [ ] The replay ends on a signup CTA
- [ ] `cd server && npm test` covers gate-off, gate-on replay, and the
      no-DB-row assertion; `npm run check` clean

## Later

If the hosted tier ever offers a genuine limited trial (a small number of real
runs on the operator's key), this story is unaffected — the demo stays the
zero-cost front door and the trial sits behind signup.
