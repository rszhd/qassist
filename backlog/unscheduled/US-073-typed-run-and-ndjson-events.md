# US-073 — Type the run object and the NDJSON events

**As a** maintainer, **I want** `npm run check` to verify every field access on
the run object and on the agent's NDJSON events, **so that** a renamed or
reshaped field fails the check at the desk, not a test — or production — three
files away.

- **Status:** 📋 Planned
- **Priority:** P2 (unscheduled — nothing is broken; this upgrades a check that
  already runs after every server edit)
- **Estimate:** ~half a day; comments-only diff, no runtime change
- **Depends on:** —

## Problem

The stack decision is `// @ts-check` + JSDoc, and `npm run check` is one of the
two load-bearing verifications for `server/src/`. Over the engine it verifies
almost nothing: the registry in `runs.js` is `Map<string, any>`, and 49 `any`
annotations sit across `server/src/` (counted 2026-08-05). Every
`run.status`, `run.result?.success`, `run.user_id` — in the engine and in every
route that reads a run — passes unchecked. Today the tests catch what the check
misses; the gap is latent, not live. The failure it leaves open: a future edit
renames or reshapes a run field, `npm run check` stays green, and the first
thing to notice is a test in another file, or nothing.

The NDJSON protocol has the same gap with higher stakes: the
`frame` / `step` / `done` / `diagnostics` / `blocked` / `recording` event shapes
cross four boundaries (Python → Express → WS → React) and exist only as prose
in `run_agent.py`'s docstring. No tool checks that the relay and the viewer
read the shape the agent writes.

## Acceptance criteria

- [ ] A `@typedef Run` exists once (in `runs.js` or a small `types.js`), and
      the registry, `getRun`, and the route handlers that read runs resolve to
      it — not to `any`
- [ ] One typedef per NDJSON event type, where tsc reads them; the
      `run_agent.py` docstring and `docs/architecture.md` point at that one
      owner rather than restating the shapes
- [ ] `Map<string, any>` is gone from `runs.js`; the `any` count across
      `server/src/` drops materially from 49, and each survivor is deliberate
- [ ] Proven sharp: misspell one run field access, watch `npm run check` go
      red, revert
- [ ] `npm test` and `npm run check` green; runtime diff is empty
