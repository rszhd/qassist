// @ts-check
// US-081: what one run is given from its test's notebook.
//
// Pure logic — no DB, no spawn — so the decision is unit-testable whole, which
// is `variables.js`'s shape and for the same reason: what this gets wrong is
// invisible. Memory changes the prompt, so a wrong answer arrives as a
// *plausible verdict* — a run that passed or failed for reasons nobody disputes,
// because nothing downstream contradicts the advice it was given. There is no
// red build and no bar to notice (backlog/correctness-critical.md).
//
// The generation itself is the agent's (`agent/run_memory.py`) — the trace is
// not in the database, and `scrub` lives there. This module decides only what is
// supplied.
//
// It is four lines because everything that used to withhold a notebook has been
// removed on purpose, in this order: a state machine, then a two-group
// invalidation matrix, then a weekly cadence, then a doubt raised by a failing
// run, then an eleven-input fingerprint, then a two-input one. Each was a rule
// the system applied to itself, and each cost a test its notebook for a change
// that left the app under test exactly where it was. **A notebook is now
// supplied until a person says otherwise** — Clear, or removing the lesson.

/** Bump to discard every learned memory of an old shape deliberately. This is
 * the only thing left that can invalidate a notebook without somebody clicking,
 * and it takes a migration to fire. */
export const MEMORY_FORMAT_VERSION = 1;

/**
 * One lesson. Provenance is per item because a notebook holds lessons from
 * several runs at once — `agent/run_memory.py` stamps them and the eviction
 * backstop reads `learned_at`.
 * @typedef {{ id: string, text?: string, attempt?: string, reason?: string,
 *             instead?: string, steps?: number[], run_id?: string | null,
 *             learned_at?: string | null, hinted?: boolean }} MemoryItem
 *
 * The three sections, as the agent writes them and the panel shows them.
 * @typedef {{ successful_approach?: MemoryItem[], avoid_next_time?: MemoryItem[],
 *             orientation?: MemoryItem[] }} Notebook
 *
 * The `test_memory` row as a run reads it (migration 021).
 * @typedef {{ learned?: Notebook | null, learned_at?: number | null }} StoredMemory
 */

/**
 * What one run is given. The one place it is settled, so there is no second path
 * that could supply something the panel does not show.
 *
 * `supplied` is the notebook itself, and it is the only value: the agent words it
 * (`run_memory.to_prompt`) and the panel renders it. A server-side rendering
 * beside it would be a second copy that has to keep agreeing with the first, and
 * the story's promise is that there is no memory visible only to the model.
 * @param {{ stored: StoredMemory | null }} request
 */
export function memoryFor({ stored }) {
  const learned = stored?.learned || null;
  if (!learned || !count(learned)) return { used: false, supplied: null };
  return { used: true, supplied: learned };
}

/** @param {Notebook} learned */
function count(learned) {
  return Object.values(learned).reduce(
    (total, section) => total + (Array.isArray(section) ? section.length : 0),
    0
  );
}
