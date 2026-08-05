# US-075 — The two run orchestrators shrink to their subject

**As a** maintainer, **I want** `server/src/runs.js` and
`frontend/src/RunView.jsx` split along their existing seams, **so that** a
change to one concern is reviewed against a file that holds that concern, not
seven.

- **Status:** 📋 Planned
- **Priority:** P3 (unscheduled — comfort and review speed only; the least
  serious of the 2026-08-05 review's three findings)
- **Estimate:** ~1 day total, best spent one seam at a time when already in
  the file
- **Depends on:** US-073 (typing the run first makes the split mechanical —
  tsc then checks what each new module receives)

## Problem

CLAUDE.md targets ≤~300 lines per file, split by feature when files grow. The
two run orchestrators are 3× over (2026-08-05):

- `runs.js` is 1,035 lines holding seven concerns: registry, admission and
  queue, persistence, WS relay, process spawn/kill, demo replay, report
  generation. The cleanest cut lines touch neither the queue nor the relay:
  the demo replay block (`startReplay` → `linkFixtureArtifacts`) and
  `generateReport`.
- `RunView.jsx` is 912 lines with ~30 `useState` hooks and a hand-written
  event switch in `handleEvent` — a reducer in disguise. A `useRun` hook
  (reducer + WS lifecycle) would leave the view holding layout.

The size also has a session cost beyond review speed: an AI coding session
must read the whole file to change one concern, so every runs task starts
~10–15k tokens deep (2026-08-05 assessment). The split repays that on every
future session, which is an argument for scheduling this earlier than its
severity alone suggests.

## Constraints

- `server/CLAUDE.md`: "the engine stays `src/runs.js`" — read here as
  routes-vs-engine, not a ban on the engine having modules; nothing moves into
  `routes/`. **Confirm that reading before starting.**
- The pre-US-023 progressive disclosure of the Run view is behavior, not
  layout — the reducer extraction must not change what renders when.

## Acceptance criteria

- [ ] Demo replay and report generation each live in their own module;
      `runs.js` keeps registry, queue, process lifecycle, relay
- [ ] `RunView.jsx`'s run state and event handling live in a reducer-backed
      hook; the component is layout and handlers
- [ ] No behavior change: server suite, frontend suite and `npm run check`
      green with no assertion edited
- [ ] Both files materially under their current line counts; record the
      before/after numbers here
