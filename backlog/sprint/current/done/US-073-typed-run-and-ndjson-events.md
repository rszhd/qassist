# US-073 — Type the run object and the NDJSON events

**As a** maintainer, **I want** `npm run check` to verify every field access on
the run object and on the agent's NDJSON events, **so that** a renamed or
reshaped field fails the check at the desk, not a test — or production — three
files away.

- **Status:** ✅ **Done** 2026-08-05, 5/5
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

- [x] A `@typedef Run` exists once (in `runs.js` or a small `types.js`), and
      the registry, `getRun`, and the route handlers that read runs resolve to
      it — not to `any`
- [x] One typedef per NDJSON event type, where tsc reads them; the
      `run_agent.py` docstring and `docs/architecture.md` point at that one
      owner rather than restating the shapes
- [x] `Map<string, any>` is gone from `runs.js`; the `any` count across
      `server/src/` drops materially from 49, and each survivor is deliberate
- [x] Proven sharp: misspell one run field access, watch `npm run check` go
      red, revert
- [x] `npm test` and `npm run check` green; runtime diff is empty

## Results

**Two owners, both at the bottom of the engine's import order.** `Run` went into
`runState.js`, which already declared itself "what a run IS"; the events went
into a new `runEvents.js`, types only, below everything. `server/CLAUDE.md`'s
layering list now names six modules under `runs.js` instead of five.

`runEvents.js` has no runtime, which is the point: the wire format has no
representation to construct. A `.js` file under `"type": "module"` is a module
to tsc without an `export {}`, so `import('./runEvents.js').RunEvent` resolves
from a file that is nothing but JSDoc. That was checked with a throwaway probe
before anything was written, along with the other assumption the whole design
rests on — that `events.filter((e) => e.type === 'step')` narrows a
discriminated union. It does: TypeScript infers the type predicate, so
`stepsOf` and `diagnosticsOf` need no cast.

**Thirteen event typedefs, not six.** The story named the six the agent writes.
The union has to hold every event that crosses the socket or the viewer's
`switch` is checked against a partial list, so `status` / `stopping` / `end` —
the server's own — are in the same file. Splitting the union by who authored
each member would hide exactly the mismatches the file exists to catch.

`StatusEvent` then had to split further. `run.queueEvent` only ever holds the
queued form, so typing that slot as `running | queued` makes `.position`
optional at the one place it is guaranteed — and `queue.test.js` reads
`third.queueEvent?.position`. Hence `RunningEvent` and `QueuedEvent` as named
members, with `StatusEvent` their union.

**The `any` cast on `createRun`'s blocked marker came out.** The old comment
said a third marker "stops tsc reducing the union". It doesn't: `'blocked' in
run` / `'rejected' in run` narrow a three-member union fine, and every caller
already branches that way before touching `run.id`. Removing the cast is what
made `createRun` return a checked `Run` — with the cast in place the `any`
swallowed the whole union and every route reading `run.status` was unchecked.
Named the two markers `Blocked` and `Rejected` so the signature says so.

**`any` across `server/src/`: 74 → 38**, counted as occurrences in a JSDoc type
position (`@type`/`@param`/`@returns`/`@typedef`/`@property`/`@template`). The
story's "49" was a different count and could not be reproduced; the script that
produced both numbers is in the commit message rather than the repo, because
this is a one-off measurement and not a check worth running forever. The engine
went to zero: `runState.js` 3 → 0, `runs.js` 8 → 1 (a `catch` binding).

Getting there needed four smaller namings beyond the two the story asked for,
each of which was a shape spelled inline in two or more places:

| Typedef | Owner | Replaced |
|---|---|---|
| `RunnableTest` | `runs.js` | The `RUNNABLE_TEST_COLS` row, spelled out identically in `runs.js` and `routes/helpers.js` |
| `VariableSpec` | `variables.js` | `Array<{name, value, secret, optional}>`, three times in one file |
| `SessionMaterial` / `StoredSecrets` | `browserSession.js` / `testSecrets.js` | `Map<string, any>` in `runTests`'s options |
| `PreambleAction` | `browserSession.js` | `any[]`, and the four-action vocabulary was written down nowhere |
| `AppRequest` | `routes/helpers.js` | 16 `/** @type {any} */ (req)` casts for the three fields the gates stash |

`RunnableTest` is declared in the engine, not beside the columns it mirrors,
because the engine is what requires the shape — the query exists to satisfy it,
so a column dropped from that `select` should fail at the consumer. It also
keeps the import pointing downward; a type-only reference from `runs.js` up
into `routes/` would be the one direction `server/CLAUDE.md` forbids.

`AppRequest` also retired a `// @ts-expect-error — request-scoped stash, no
augmentation needed` in `routes/projects.js`. The stash decision stands (no
global `Express.Request` augmentation — these exist for one request and a
declaration everybody sees would claim they are always there); it is the *reads*
that are now checked.

**The 38 survivors are four classes, all deliberate.** Unvalidated input being
narrowed by hand (`req.body`, jsonb columns, `normalizeStorageState`) — the
`any` *is* the untrusted value and the function exists to turn it into a checked
shape; `pg` parameter arrays and rows, which are genuinely heterogeneous;
`catch` bindings; and Stripe's event payloads. One is a false positive: the word
"any" in a sentence in `config.js`.

`normalizeStorageState` is the honest failure. Its guards are negative
(`if (cookies !== undefined && !Array.isArray(cookies)) return {error}`), which
narrows nothing for the code after them, so `Record<string, unknown>` breaks it
and `any` stays. The four `*Params` validators beside it took the narrowing
fine and were converted.

**Proven sharp (AC #4), twice** — once per typedef, each at the distance the
story is about:

    -    has_recording: !!run.recordingFile,        (runReport.js)
    +    has_recording: !!run.recording_file,
    src/runReport.js(53,26): error TS2551: Property 'recording_file' does not
      exist on type 'Run'. Did you mean 'recordingFile'?

    -      run.recordingFile = evt.file;            (runs.js — the agent renames it)
    +      run.recordingFile = evt.path;
    src/runs.js(582,33): error TS2339: Property 'path' does not exist on
      type 'RecordingEvent'.

Both reverted. 724 server tests pass, 237 agent tests pass, `npm run check`
green, `check-doc-links` green.

**The runtime diff is not quite empty**, and the exception is worth naming.
`stop-run.test.js` polled `run.events.some((e) => e.message === 'stub ready')`,
which does not typecheck against a union where only some members carry
`message`. It became `e.type === 'log' && e.message === 'stub ready'` — the same
predicate, since `fake_agent.js` emits that on a `log` event and nothing else
carries the string, but it is a changed line in a test rather than a comment.
Everything else is annotations, two casts that produce the same value, and the
docstring rewrites.

### Tradeoffs

**Nine test files got a widened or cast `createRun` return.** Five of them
(`concurrency-*`) assert *which* union member came back, including that a
rejected one carries no `status` at all — an assertion the narrowed type refuses
to let them make, so their `start` helper is a documented `any`. The other four
never exercise a marker, so they cast to `Run` once at the helper and keep every
field read checked. Neither is loosening: the point of those five tests is the
return shape, and the type would be asserting the thing under test.

**The frontend is still unchecked.** It has no `tsc` at all, so "Python →
Express → WS → React" is now verified over the first three hops and not the
fourth. `runEvents.js` is where a frontend typedef would import from if that
ever changes; nothing was done speculatively.

**A stronger `req` story was left alone.** Sixteen casts became one named type,
but a global `Express.Request` augmentation would have removed the casts
entirely. That needs a `.d.ts`, and the maintainer's `@ts-expect-error` had
already recorded the opposite call.
