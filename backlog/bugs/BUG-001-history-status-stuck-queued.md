# BUG-001: History shows a run as "Queued" while it is actually running

**Status:** ✅ Fixed (2026-07-24)
**Reported:** 2026-07-24
**Area:** server (`server/src/runs.js`), visible in the History view

## Fix

Per-run DB writes are now serialised on `run.persisted`: `persistInsert`
stores the insert promise there, and every `persistUpdate` chains off it
(`run.persisted = (run.persisted || Promise.resolve()).then(update)`). An
update can no longer reach a pool connection before the row it targets exists.
Still fire-and-forget — nothing on the request path awaits the chain.

Regression test: `server/test/run-status-persistence.test.js`. pg-mem resolves
queries deterministically and never reproduces the race, so it guards the
invariant instead: with the runs INSERT held open, the `running` UPDATE must
not have been issued. The pre-fix code issued it synchronously inside
`createRun`, so the test fails on the old code and passes on the fix.

## Symptom

On the History page a run keeps its `queued` badge even after it has started
running. It only flips to the real status (`running` → `passed`/`failed`/…)
when the run finishes. The live Run view is unaffected — it shows `Running…`
correctly, because it reads WebSocket status events, not the DB.

## Root cause — a fire-and-forget persistence race

History reads run status from Postgres. The DB row is written by two
*independent* fire-and-forget queries against the pool, with no ordering
guarantee between them:

- `enqueue` → `persistInsert(run)` — `INSERT … status = 'queued'`
  (`runs.js:198`, value from `runs.js:191`).
- `startRun` → `persistUpdate(run)` — `UPDATE runs SET status='running' …
  WHERE id=$1` (`runs.js:294`).

When a slot is free (the common case) `startRun` is called synchronously
right after `persistInsert` (`runs.js:199-200`), so both queries are in flight
at once. `db()` is the pool, so the two queries can land on different
connections and execute in either order. If the `UPDATE` runs before the
`INSERT` has committed, it matches **zero rows** and is silently lost; the
`INSERT` then commits with `status='queued'`. The row is stuck at `queued`
until the terminal `persistUpdate` at run completion overwrites it.

Because it is a race, it is intermittent — fast/idle DB makes the insert win
and the bug hides; that is why it is easy to miss in dev.

## Fix options considered (option 1 shipped)

1. **Order the writes.** Chain the running-`UPDATE` off the insert's promise so
   it can never precede the insert (have `persistInsert` return its promise and
   `startRun` await/`.then` it, or trigger the first `persistUpdate` from
   insert completion). Keeps the "relay never waits on the DB" property — the
   chaining is off the DB promise, not the request path.
2. **Insert with the real status.** When `enqueue` starts the run immediately,
   the row's first write is already `running`; only genuinely queued runs
   insert as `queued`. Avoids the second write entirely for the common path but
   splits the status source between the two branches of `enqueue`.

Option 1 is preferred — it fixes the ordering without special-casing the
queue-vs-immediate branches.

## Notes for the fix

- Add a regression test. The existing server suite stubs the agent/report and
  runs the app in-process; assert that after `enqueue` starts a run, the DB row
  reaches `running` (not `queued`). Ordering-sensitive DB behaviour is exactly
  the class `docs/testing.md` flags for a real-Postgres test rather than
  pg-mem — see `scheduler-postgres.test.js` for the pattern.
- History already polls every 5s while any row is `queued`/`running`
  (`HistoryView.jsx:116-121`), so once the DB holds `running` the UI corrects
  itself with no frontend change.
