// @ts-check
// US-081's Run memory panel: what a test remembers, and the two things a person
// may do about it.
//
// Its own file rather than three more routes in `tests.js`, which is already at
// the size the project targets. The seam is clean anyway — nothing here is part
// of creating or running a test, and the story's own rule is that none of it is
// a step anybody has to take.
//
// The read carries a promise: the panel shows the exact notebook the next run
// receives, so both go through `memoryFor`. Anything less and the panel becomes
// a plausible description of a prompt rather than the prompt.
//
// Every write here is a deletion. "Learned" means a trace produced it, so a body
// that could add a lesson would let hand-written advice claim provenance it does
// not have — and the first build proved the alternative costs more than it gives.
import express from 'express';
import { db, currentUserId, isUuid } from '../db.js';
import { memoryFor } from '../testMemory.js';
import { clearMemory, memoryOf, removeLesson } from '../testMemoryStore.js';
import { h, requireDb, RUNNABLE_TEST_COLS, RUNNABLE_TEST_FROM } from './helpers.js';

/**
 * The panel's JSON. `learned` is the row; `supplied` is what the next run gets,
 * and they are the same thing unless the notebook is empty — the story's "no
 * hidden memory visible only to the model", made checkable.
 *
 * Both are returned rather than one, because they were not always equal and the
 * check is the point: if a rule that withholds a notebook ever comes back, the
 * panel has to be able to show it.
 * @param {any} row
 */
function shapeMemory(row) {
  return {
    learned: row?.learned ?? {},
    learned_at: row?.learned_at ?? null,
    supplied: memoryFor({ stored: row }).supplied,
  };
}

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function testMemoryRouter({ checkToken }) {
  const r = express.Router({ mergeParams: true });
  r.use(checkToken, requireDb);

  /** The caller's own test, or null. Scoped to the owner, so a cross-user read 404s. */
  async function ownTest(req) {
    if (!isUuid(req.params.id)) return null;
    const { rows } = await db().query(
      `select ${RUNNABLE_TEST_COLS} from ${RUNNABLE_TEST_FROM}
        where t.id = $1 and t.user_id = $2`,
      [req.params.id, currentUserId()]
    );
    return rows[0] || null;
  }

  r.get(
    '/',
    h(async (req, res) => {
      const test = await ownTest(req);
      if (!test) return res.status(404).json({ error: 'not found' });
      res.json(shapeMemory(await memoryOf(test.id)));
    })
  );

  // Remove one lesson that is wrong. The rest of the notebook stands and is
  // still supplied; only the last removal leaves a test with nothing to say.
  r.delete(
    '/lessons/:itemId',
    h(async (req, res) => {
      const test = await ownTest(req);
      if (!test) return res.status(404).json({ error: 'not found' });
      const saved = await removeLesson(test.id, req.params.itemId);
      if (!saved) return res.status(404).json({ error: 'not found' });
      res.json(shapeMemory(saved));
    })
  );

  // Clear. The row goes, so the next run is a first run again and learns the
  // flow fresh. Run history is untouched — the row is the disposable one, which
  // is the whole reason it is a row of its own.
  r.delete(
    '/',
    h(async (req, res) => {
      const test = await ownTest(req);
      if (!test) return res.status(404).json({ error: 'not found' });
      await clearMemory(test.id);
      res.status(204).end();
    })
  );

  return r;
}
