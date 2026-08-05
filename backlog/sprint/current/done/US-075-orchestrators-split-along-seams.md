# US-075 — The two run orchestrators shrink to their subject

**As a** maintainer, **I want** `server/src/runs.js` and
`frontend/src/RunView.jsx` split along their existing seams, **so that** a
change to one concern is reviewed against a file that holds that concern, not
seven.

- **Status:** ✅ Done (2026-08-05)
- **Priority:** P3 (unscheduled — comfort and review speed only; the least
  serious of the 2026-08-05 review's three findings)
- **Estimate:** ~1 day total, best spent one seam at a time when already in
  the file
- **Depends on:** US-073 (typing the run first makes the split mechanical —
  tsc then checks what each new module receives). **Shipped without it**, and
  the dependency was real: `npm run check` covers the server, so the five new
  engine modules were checked, but nothing typed the frontend seam. The one
  defect this work introduced was on that side, and it was a *type* of defect
  tsc does not catch either — a function's identity, not its signature. So
  US-073 would not have prevented it. The dependency was worth less than the
  header claimed; US-073 stays P2 on its own merits.

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

- [x] Demo replay and report generation each live in their own module;
      `runs.js` keeps registry, queue, process lifecycle, relay
- [x] `RunView.jsx`'s run state and event handling live in a reducer-backed
      hook; the component is layout and handlers
- [x] No behavior change: server suite, frontend suite and `npm run check`
      green with no assertion edited
- [x] Both files materially under their current line counts; record the
      before/after numbers here

## Result

| File | Before | After |
|---|---|---|
| `server/src/runs.js` | 1,035 | 646 |
| `frontend/src/RunView.jsx` | 912 | 692 |

The engine gained five modules — `runState.js` (95), `runRelay.js` (62),
`runPersistence.js` (105), `runReport.js` (87), `runReplay.js` (106) — and the
view one hook, `useRun.js` (317). The layering and the rule that keeps it are
in `server/CLAUDE.md`; the module table is in `docs/architecture.md`.

Green with no assertion edited: server 724 tests, `npm run check` clean,
frontend 107 tests, `vite build` clean.

## What the split cost, and the one thing to know before doing it again

**A `useState` setter is a stable identity; a dispatcher you write is not.**
The extraction replaced `setError` and `setSubscribed` — both `useState`
setters — with arrow functions built fresh inside `useRun` on every render.
Five dependency arrays in the view hold `setError`: `loadTests`,
`loadProjects`, and three `useProjectList` calls. Each fetch set state, the
re-render minted a new `setError`, and the effects refired on the state they
had just set.

It does not fail like a bug. `RunView.test.jsx` never failed — it never
*finished*, and neither did the suite around it: four vitest workers at 99% CPU
with no output past the banner, which reads as a slow machine rather than a
regression. Every callback `useRun` returns is now `useCallback`-wrapped, and
the comment above them says why a one-line body is still worth wrapping.

The general shape, for the next hook extracted from a component: **moving state
out of a component changes the identity guarantees its consumers were built
on**, and nothing type-checks that. Suspect it whenever the suite goes quiet
instead of red.
