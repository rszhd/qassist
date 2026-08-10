// @ts-check
// US-081: reading the `test_memory` row, and the two escape hatches that edit
// it. Nothing else.
//
// Split from `testMemory.js` on purpose. That module is the whole decision — the
// fingerprint, what a run is given, what may be written — and it is pure so the
// decision can be unit-tested whole, which is `variables.js`'s shape. This file
// is the query that feeds it. Keeping the two apart is what stops the decision
// growing a dependency on a live database and becoming untestable a piece at a
// time.
//
// A run's own write lives in `runPersistence.js` instead, beside the other
// things a finished run stores, because it is chained on `run.persisted` with
// them and must reach the DB in the same program order.
import { db } from './db.js';

/** @typedef {import('./testMemory.js').StoredMemory} StoredMemory */

const SECTIONS = ['successful_approach', 'avoid_next_time', 'orientation'];

/**
 * The stored notebooks for a batch of runnable tests, keyed by test id.
 *
 * Resolved HERE, before `createRun`, exactly as `sessionsForTests` and
 * `secretsForTests` are and for the same reason: the run engine is synchronous,
 * every trigger path funnels through it, and this is a DB read.
 *
 * Unlike those two there is no `error` case, and that is deliberate. A session
 * that will not decrypt must stop its run, because starting signed-out reports
 * the app as broken. A notebook that cannot be read is only a run that will not
 * be helped by one — it is an optimisation, and failing a run over it would make
 * a feature meant to be safe to ignore the reason a nightly suite went red. So a
 * failed read logs and yields nothing, and every test in the batch runs cold.
 * @param {{ id: string }[]} tests
 * @returns {Promise<Map<string, StoredMemory>>}
 */
export async function memoryForTests(tests) {
  /** @type {Map<string, StoredMemory>} */
  const byTest = new Map();
  const ids = tests.map((t) => t.id).filter(Boolean);
  if (!ids.length || !db()) return byTest;

  // Spelled out as placeholders rather than bound as one array parameter:
  // pg-mem has no array parameter binding. `browserSession.js` and
  // `routes/projects.js` document the same trap.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  let rows;
  try {
    ({ rows } = await db().query(
      `select test_id, fingerprint, learned, learned_at
         from test_memory where test_id in (${placeholders})`,
      ids
    ));
  } catch (err) {
    console.error('db: read test memory failed:', /** @type {any} */ (err).message);
    return byTest;
  }

  for (const row of rows) {
    byTest.set(row.test_id, {
      fingerprint: row.fingerprint,
      // `jsonb` arrives parsed from `pg`; the default is what a row written
      // before a section existed reads as.
      learned: row.learned || {},
      learned_at: row.learned_at ? new Date(row.learned_at).getTime() : null,
    });
  }
  return byTest;
}

/**
 * The whole row for one test, for the panel — which needs what a run does not:
 * the times.
 * @param {string} testId
 */
export async function memoryOf(testId) {
  if (!db()) return null;
  const { rows } = await db().query('select * from test_memory where test_id = $1', [testId]);
  return rows[0] || null;
}

/**
 * Remove one lesson that is wrong.
 *
 * Read, filter, write. The alternative is a `jsonb_agg` over
 * `jsonb_array_elements` in the statement itself, which is atomic and which
 * pg-mem cannot run — so it would move every route test that touches this onto
 * a real server to buy a guarantee this does not need. The race it leaves is a
 * run finishing between the read and the write, whose merged notebook still
 * holds the removed lesson: the lesson comes back, and removing it again works.
 * A notebook is an optimisation, and that is the right price.
 *
 * Removing the last lesson leaves an empty notebook rather than deleting the
 * row, so the fingerprint stays and the next run is cold without being a first
 * run.
 * @param {string} testId
 * @param {string} itemId
 */
export async function removeLesson(testId, itemId) {
  if (!db()) return null;
  const { rows } = await db().query(
    'select learned from test_memory where test_id = $1',
    [testId]
  );
  if (!rows.length) return null;
  const learned = rows[0].learned || {};
  const kept = Object.fromEntries(
    SECTIONS.map((section) => [
      section,
      (learned[section] || []).filter((/** @type {any} */ item) => item?.id !== itemId),
    ])
  );
  const { rows: updated } = await db().query(
    `update test_memory set learned = $2, updated_at = now()
      where test_id = $1 returning *`,
    [testId, JSON.stringify(kept)]
  );
  return updated[0] || null;
}

/**
 * Re-key the notebook to the test's current inputs — a person answering the one
 * question the fingerprint cannot ask.
 *
 * The hash knows THAT the instructions changed and never whether the lessons
 * still hold: a typo fixed in the goal and the test repointed at another app look
 * identical to it. So the automatic answer is the safe one — withhold, relearn —
 * and this is the deliberate override, taken with the edit in front of you.
 *
 * It moves the key and nothing else. The lessons, their provenance and
 * `learned_at` are untouched, because nothing was learned here; a run that
 * started before the re-key still carries the old fingerprint and its write is
 * still refused, which is correct.
 * @param {string} testId
 * @param {string} fingerprint
 */
export async function rekeyMemory(testId, fingerprint) {
  if (!db()) return null;
  const { rows } = await db().query(
    `update test_memory set fingerprint = $2, updated_at = now()
      where test_id = $1 returning *`,
    [testId, fingerprint]
  );
  return rows[0] || null;
}

/**
 * Clear the notebook without touching run history — which is the whole reason
 * this is a delete of one disposable row and not a change to anything a run
 * recorded. The next run starts cold and learns fresh.
 *
 * A delete rather than an empty notebook, because Clear also throws away the
 * doubt and the fingerprint: the story's four cold cases include "a run of a
 * test whose memory was just cleared", and a test with no row is exactly a test
 * that has never learned.
 * @param {string} testId
 */
export async function clearMemory(testId) {
  if (!db()) return;
  await db().query('delete from test_memory where test_id = $1', [testId]);
}
