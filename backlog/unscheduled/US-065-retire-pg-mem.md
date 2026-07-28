# US-065 — Retire pg-mem: every test runs against the database we ship

**As a** maintainer, **I want** the test suite to run against real Postgres
throughout, **so that** a green suite stops meaning "green against an engine
that is not the one in production", and the standing tax of finding out where
the fake lies goes away.

- **Status:** 📋 Planned
- **Priority:** P2 (unscheduled — nothing is broken; this removes a class of
  future surprises, and the incremental policy below covers the interim)
- **Estimate:** ~1–2 days, but see "Do it incrementally" — the point of the
  story is that it should probably never be done in one sitting
- **Depends on:** — (amends `docs/testing.md`; CI already provides the service)

## Problem

`docs/testing.md` now lists **eight** distinct ways pg-mem is not Postgres,
every one of them found by something breaking:

uncast `text[]` defaults arriving as the string `"{}"` · `on conflict do
nothing` reporting `rowCount: 1` · inline `check` in `alter table add column`
not parsing, and the named form parsing without being enforced · the two
engines auto-naming an inline column check differently · node-pg's type parsers
never running, so a bigint `count(*)` is a number here and a string in
production · correlated subqueries unable to see an outer alias · partial
indexes returning wrong rows · `bytea` parameters squeezed through a UTF-8
string.

Nine `*-postgres.test.js` files already exist to cover what that list makes
untestable. So the fake is not saving a real-server dependency — it is running
*alongside* one.

BUG-007 and BUG-008 are what turned this from an aesthetic complaint into a
story. The bytea gap was documented, but the documented version said the
corruption was silent. It is not: 1.6% of ciphertexts at the size US-043 stores
make the adapter build SQL pg-mem's own parser rejects, and the parse error
enumerates the tokens it expected — one of which is `kw_unique`. A route
classifying errors by message then answered **409 Conflict** for a name nothing
had ever held. One fake's blind spot, presenting as a timeout in one place and
a plausible business-logic conflict in another, on a schedule set by a random
IV. It read as a flaky suite for a day.

That is the real cost, and it is not the eight known lies. It is the ninth.

## Why "it's slower" is not the objection

Measured 2026-07-28 on the 8-core dev box:

| | |
|---|---|
| Nine `*-postgres.test.js` files | 46 tests, **7.6s serial** |
| Per-file cost of create-db + migrate + drop | **~450ms** |
| Node startup floor, empty test file | ~140ms |
| Converting the remaining 28 pg-mem files | ~12s serial, **~2s wall** at concurrency 7 |
| Suite today | 634 tests, ~35s wall |

So the honest estimate is **~35s → ~40s**. CI already runs a
`postgres:16-alpine` service and already fails the build if the `-postgres`
files report as skipped, so the infrastructure exists on both ends.

The one thing genuinely lost is that `npm test` today needs no services at all.
That is worth naming, but `predev` already does
`docker compose up -d --wait db`, so any machine doing development has the
database up regardless.

## Why this is unscheduled rather than queued

The risk is the diff, not the engine. Twenty-eight files, several of them
assertion-first specs on `correctness-critical.md`, converted in one sweep — a
large change to the thing that catches changes, whose failure mode is a file
that quietly stops asserting what its name says. A conversion that drops an
assertion looks exactly like a conversion that kept it.

## Do it incrementally (this part starts now)

The policy, which needs no scheduling and is the substance of the story:

1. **A new test file uses real Postgres.** `session-postgres.test.js` is the
   pattern — create a uniquely-named database, run migrations, drop it after.
2. **Convert an existing pg-mem file the next time it lies to you.** Then the
   conversion is one file, reviewed against a failure already understood, and
   justified by a test that was wrong rather than by a preference.
3. **When a file converts, its `*-postgres.test.js` counterpart folds back
   in** — the split exists only because the fake could not hold the claim up.

If that converges, this story closes without ever being scheduled, which is the
intended outcome. Schedule it only if the pg-mem list reaches ten and the
incremental route has not moved.

## Acceptance criteria

- [ ] No `pg-mem` import remains under `server/test/`, and the dependency is
      out of `server/package.json`
- [ ] `*-postgres.test.js` suffixes are gone — the distinction stops meaning
      anything once there is one engine
- [ ] `server/test/helpers/stored-key.js` is deleted: `registerDecode`,
      `byteaPool` and `seedStoredKey`'s inline-hex write all exist solely to
      work around the fake (13 files import from it today)
- [ ] `skipIndexes` is gone from `runMigrations` — it exists because pg-mem's
      partial indexes return wrong rows, and tests then run against a schema
      that is not the shipped one
- [ ] `docs/testing.md`'s pg-mem section becomes history rather than guidance,
      and the two-tests-one-feature rule is restated for what still needs it
      (the browser, the LLM, real mail)
- [ ] Suite wall time recorded before and after, in the story

## Notes

- The eight lies should survive the deletion as a *list*, somewhere. They are
  the strongest argument this repo has for "use the real thing", and every one
  of them cost a debugging session to learn.
- Watch for assertions that only pass *because* pg-mem is lenient — the
  reverse of the known list, and invisible until the file converts. An
  uncast `count(*)` compared with `=== 0` is the shape: correct on the fake,
  wrong on the server, and BUG-006 already found one of those.
- `runMigrations` applying every migration per file is the ~450ms; a template
  database created once and cloned per file with `create database … template`
  would cut it if the wall time ever matters.
