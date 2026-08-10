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
// receives, so both come from `previewMemory` over the same resolved inputs
// `createRun` uses. Anything less and the panel becomes a plausible description
// of a prompt rather than the prompt.
//
// No lesson can be written here. "Learned" means a trace produced it, so a body
// that could add one would let hand-written advice claim provenance it does not
// have — and the first build proved the alternative costs more than it gives.
// Two of the three controls are deletions; the third moves the key and never the
// lessons.
import express from 'express';
import { db, currentUserId, isUuid } from '../db.js';
import { previewMemory } from '../runs.js';
import { clearMemory, memoryOf, rekeyMemory, removeLesson } from '../testMemoryStore.js';
import {
  h, requireDb, RUNNABLE_TEST_COLS, RUNNABLE_TEST_FROM, runnableFieldsFor,
} from './helpers.js';

/**
 * The panel's JSON: the row, and the decision over it.
 *
 * `supplied` is what the next run is handed, and it is the same value the panel
 * renders — the story's "no hidden memory visible only to the model", made
 * checkable. It differs from `learned` exactly when something changed since the
 * notebook was written, which is the case the panel most needs to explain, and
 * `withheld` is the reason.
 * @param {any} test @param {any} row
 */
async function shapeMemory(test, row) {
  const base = {
    learned: row?.learned ?? {},
    learned_at: row?.learned_at ?? null,
  };
  const resolved = await runnableFieldsFor(test);
  // A notebook is an optimisation, so nothing here may fail a request: a secret
  // that will not decrypt stops a *run*, and it must not also stop someone
  // reading what their test learned. The stored lessons are still shown; only
  // the "what the next run gets" preview is withheld, with its reason.
  if ('error' in resolved) {
    return { ...base, supplied: null, withheld: null, preview_error: resolved.error };
  }
  const preview = previewMemory(resolved.fields);
  return {
    ...base,
    supplied: preview.supplied,
    withheld: preview.withheld,
    preview_error: null,
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
      res.json(await shapeMemory(test, await memoryOf(test.id)));
    })
  );

  // Remove one lesson that is wrong. The rest of the notebook stands, and the
  // fingerprint does not move — this is not an edit to what the test means, so
  // the next run is still assisted by what is left.
  r.delete(
    '/lessons/:itemId',
    h(async (req, res) => {
      const test = await ownTest(req);
      if (!test) return res.status(404).json({ error: 'not found' });
      const saved = await removeLesson(test.id, req.params.itemId);
      if (!saved) return res.status(404).json({ error: 'not found' });
      res.json(await shapeMemory(test, saved));
    })
  );

  // "These lessons still apply." The person's answer to the question the
  // fingerprint cannot ask — it knows the instructions changed, never whether
  // that changed the flow. Nothing is written but the key.
  r.post(
    '/keep',
    h(async (req, res) => {
      const test = await ownTest(req);
      if (!test) return res.status(404).json({ error: 'not found' });
      const resolved = await runnableFieldsFor(test);
      if ('error' in resolved) return res.status(400).json({ error: resolved.error });
      const saved = await rekeyMemory(test.id, previewMemory(resolved.fields).fingerprint);
      if (!saved) return res.status(404).json({ error: 'not found' });
      res.json(await shapeMemory(test, saved));
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
