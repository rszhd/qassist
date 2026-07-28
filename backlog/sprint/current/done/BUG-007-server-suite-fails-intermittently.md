# BUG-007 — The server suite fails intermittently, on a different test each time

- **Status:** ✅ Fixed 2026-07-28 — two causes, and **neither of them was the
  one this file first diagnosed**. Found 2026-07-28 while verifying
  [BUG-006](BUG-006-empty-scheduled-target-reports-a-run.md).
  It reproduces on a clean `dev` with that work stashed, so it is older than
  the change that surfaced it.
- **Lives in:** the test harness rather than the product —
  `server/test/helpers/stored-key.js`, `server/test/stubs/fake_agent.js`, and
  the two test files that used them.
- **Severity:** high for how we work, zero for a user. `CLAUDE.md` says CI does
  **not** run on a push to `dev` — only on a PR into it — so `npm test` locally
  is the load-bearing gate, not a courtesy. A suite that fails for reasons
  unrelated to the change trains us to re-run until green, and re-running until
  green is exactly how a real regression gets waved through. `docs/testing.md`
  already names the stake: "a fast hermetic suite is what lets the AI run the
  whole thing after every change and self-correct without a human in the loop. A
  slow or flaky suite breaks that loop — it gets skipped, or a green run gets
  trusted that shouldn't be."

## What happens

Roughly one full run in four or five fails, and **almost never on the same
test twice**. Five distinct names seen over ~13 runs on 2026-07-28, at most one
per run:

- `P-fair (dequeue): a freed slot is left idle rather than promoting an at-cap user`
  (`concurrency-fairshare.test.js`)
- `a session can be created empty and filled by its login test`
  (`session-containment.test.js`)
- `the paste endpoint stores ciphertext and answers with metadata only` (same file)
- `a passing login run refreshes the session it belongs to` (same file)
- `a resolved run key reaches only the child env, and the request key beats the
  stored one`

## Why — the first diagnosis, and why it was wrong

The original reading was oversubscription: `node --test` runs the 60 files
roughly one per core, `fake_agent.js` implements a hold as wall-clock
`setTimeout`, so a starved child misses a poll deadline and whichever test drew
the short straw fails. It fits the shape of the evidence — different test each
time, never two at once, no correlation with the change under test.

It is not what was happening. Two measurements retired it:

- **The suite run six times with four cores held busy by spinners: zero
  failures**, at 37-42s wall against 30s idle. If contention were the mechanism,
  that is where it would show.
- **`session-containment.test.js` run 40 times *by itself*, no parallelism and
  no load, fails 4 times.** Three of the five names are in that file, and a
  single file running alone cannot be starved by a runner that is not running
  anything else.

So the flakiness was not one cause with a stochastic victim. It was two
unrelated causes, each deterministic in mechanism and random only in its input.

## Cause 1 — pg-mem's bytea gap, three of the five names

`docs/testing.md` already records that **pg-mem corrupts a `bytea` parameter**:
the adapter inlines every parameter into the SQL text and a Buffer goes through
a UTF-8 string on the way, so ciphertext comes back mangled. What was not
recorded is that the corruption is **not always silent**. Sometimes the escaped
string it builds is SQL pg-mem's own parser then rejects, and whether it is
depends on nothing but the random AES-GCM IV.

Measured directly: **1.6% of ciphertexts** of the size this story stores (213
bytes) make the adapter produce a query that throws
`Bad escaped character in JSON at position 2`. `session-containment.test.js`
was the **only file in the suite** passing a Buffer parameter to pg-mem, three
times per run — which is the ~10% per-run failure rate observed.

The throw then surfaces two different ways, which is why it looked like two
different bugs:

- `refreshCapturedSession` is fire-and-forget by design, so the failure is
  logged and the update simply never lands — and the test polling for the
  ciphertext to change times out 8s later.
- On the paste route the throw reaches `isUniqueViolation`, whose fallback is
  `/unique|duplicate/i` over the message. pg-mem's parse error lists the tokens
  it expected, and one of them is `A "kw_unique" token`. So the route answers
  **409 Conflict — "this project already has a session called pasted in"** for a
  name nothing else has ever used. That is the test the original diagnosis
  flagged as anomalous because it "does no polling and no spawning at all".

**Fix:** `byteaPool` in `test/helpers/stored-key.js` — a pg-mem pool that
rewrites each Buffer parameter to the hex `decode` form `seedStoredKey` already
writes by hand, so the round trip is exact. It is the same escape hatch that
file has always documented, applied to the parameters *product* code passes
rather than only to the ones a seed writes.

This makes the file's existing assertions stronger, not weaker: before the fix
the stored ciphertext was UTF-8-mangled on every single run, and "it isn't
plaintext" and "it changed" are both satisfied by garbage.

## Cause 2 — a drain budget spent to 97%, one of the five names

`P-fair (dequeue)` starts three runs holding 4000ms and one holding 250ms. The
in-test assertion is quick, but the `afterEach` then has to wait out two
*sequential* rounds of 4000ms holds — a1/a2, then the a3 they unblock — inside
an 8000ms deadline.

Its total duration was **8220-8433ms across twelve runs**, of which ~7.8s was
the drain. It was not marginal on a bad day; it finished with ~200ms to spare
every single day, and the variance to lose that is smaller than the variance
the box already has.

The two override tests in `concurrency-override.test.js` are built the same way
— 8055ms and 7922ms — but against a 15000ms budget, so they were merely slow.

**Fix:** `release=<name>` in `fake_agent.js`. A run holds its slot until the
test drops the named file, so "B's slot frees first" is stated rather than
raced. A file named `all` frees everything, so a test that fails before its own
release calls cannot wedge the drain. Applied to all three tests.

⚠️ **No timeout was raised, and no assertion was touched.** The `deepEqual` that
guards the fair-share dequeue is byte-for-byte what it was; only the wait in
front of it changed. The distinction the original note protects — *this test
timed out* versus *this test observed the wrong promotion* — is now sharper, not
blunter, because a timeout can no longer mean "the box was busy".

## Evidence

| | before | after |
|---|---|---|
| Full suite, clean box | 1 failure in 8 runs | **0 in 10** |
| Full suite, 4 cores held busy | 0 in 6 | — |
| `session-containment.test.js` alone, ×40 | **4 failures** | **0** |
| `openai-key-postgres.test.js` alone, ×30 | 0 | 0 |
| `P-fair (dequeue)` duration | 8290ms / 8000ms budget | **145ms** |
| `concurrency-override.test.js` file | 17.0s | **2.5s** |
| Suite wall (mean) | 30.6s | 34.8s |

The suite got ~4s *slower* despite losing 24s of sleeping, which is consistent:
those two files previously held two of the seven worker slots while doing
nothing, so fewer files competed for CPU at once. The work is the same; it is
now packed rather than spread.

## Left open

- **`a resolved run key reaches only the child env, and the request key beats
  the stored one`** is unexplained. It was never captured with its error text,
  it did not reproduce in 30 isolated runs or in 24 suite runs, and it takes
  260-360ms against 5000ms poll deadlines — a 14× margin that contention would
  have to close to fail. If it returns, capture the text before assuming it
  belongs to either cause above.
- **`isUniqueViolation`'s message fallback is a product defect**, not a test
  one. `err.code === '23505'` is authoritative on a real server; the
  `/unique|duplicate/i` half exists to cover engines that do not set `code`, and
  it will report any error whose text happens to say "unique" to the user as a
  name clash. It has the same shape in `routes/fixtures.js`. Not fixed here —
  it needs its own story, and no pg-mem test can hold up the fix.
- **The thinnest remaining margin** is `a queued run is dequeued, never spawns,
  and does not touch the slot count` (`stop-run.test.js`) at 4.6s against 8s.
  Comfortable, and left alone: nothing in the evidence points at it.

## Guarded by

Awkward by nature — the property is "green means green", which no single
assertion states. The honest check is the one used to find it: run the whole
suite N times and count, and run a suspect file alone N times and count. The
second is the one that mattered here; a fault that survives being run by itself
is not a scheduling fault, and that one measurement is what turned a plausible
diagnosis into the right one.
