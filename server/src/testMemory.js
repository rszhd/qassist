// @ts-check
// US-081: the cross-run memory of a saved test — the fingerprint that decides
// whether last run's advice still applies, what one run is given, and which
// finished runs may write.
//
// Pure logic — no DB, no spawn — so the whole surface is unit-testable, which is
// `variables.js`'s shape and for the same reason: what this module gets wrong is
// invisible. Memory changes the prompt, so a wrong answer here arrives as a
// *plausible verdict* — a run that passed or failed for reasons nobody disputes,
// because nothing downstream contradicts the advice it was given. There is no
// red build and no bar to notice; the symptom is that the fleet slowly gets
// worse at flows it used to handle (backlog/correctness-critical.md).
//
// The generation itself is the agent's (`agent/run_memory.py`) — the trace is
// not in the database, and `scrub` lives there. This module decides what is
// *supplied* and what may be *kept*.
//
// It is small on purpose. The first build had two hashes, a four-state machine,
// an invalidation matrix, a weekly cadence and a force-cold flag; all of it
// existed to serve a hand-written half of the notebook that was cut, and none of
// it was revisited when that half went. One hash and one rule replaced the lot:
// **the fingerprint differs, the notebook does not apply.** Every state the
// columns used to hold is derived here on read, where the row cannot go stale.

import { createHash } from 'node:crypto';

/** Bump to discard every learned memory of an old shape deliberately. */
export const MEMORY_FORMAT_VERSION = 1;

/**
 * One lesson. Provenance is per item because a notebook holds lessons from
 * several runs at once — `agent/run_memory.py` stamps them and the backstop
 * evicts by `learned_at`.
 * @typedef {{ id: string, text?: string, attempt?: string, reason?: string,
 *             instead?: string, steps?: number[], run_id?: string | null,
 *             learned_at?: string | null, hinted?: boolean }} MemoryItem
 *
 * The three sections, as the agent writes them and the panel shows them.
 * @typedef {{ successful_approach?: MemoryItem[], avoid_next_time?: MemoryItem[],
 *             orientation?: MemoryItem[] }} Notebook
 *
 * The `test_memory` row as a run reads it (migration 021). Four fields, and the
 * absences are the design: no state column, no `enabled`, and nothing recording
 * a run that went wrong. Memory cannot be turned off, only cleared, and only a
 * *passing* run ever changes it.
 * @typedef {{ fingerprint?: string, learned?: Notebook | null,
 *             learned_at?: number | null }} StoredMemory
 *
 * What the fingerprint is taken over. Two fields, and everything a caller
 * passes beside them is ignored — including `secrets`, which must be ignored
 * entirely rather than merely left out of the caller's object.
 * @typedef {{ goal: string, start_url: string, [key: string]: unknown }} MemoryInputs
 */

/**
 * SHA-256 over the two things that decide whether a notebook still describes the
 * flow it was written about: the **resolved instructions** and the **normalized
 * start URL**. Resolve, canonicalize, then hash.
 *
 * It was eleven inputs, and that asked the wrong question — "did anything about
 * this run change?" rather than "is this still the same flow through the same
 * app?". The model swapped on the box, a session re-captured overnight, a fixture
 * added to the project, `ALLOWED_DOMAINS` edited in config: each one wiped every
 * notebook on the instance for a change that left the app exactly where it was.
 * A notebook is advice about a *user interface*, and none of those touch one.
 *
 * Two things are still caught for free, because the goal is hashed
 * post-substitution. A variable that reaches the instructions moves the hash —
 * `log in as {{role}}` is a different flow for admin and for viewer. And a
 * secret's **value never enters it**, because `resolveForRun` leaves the literal
 * `<secret>name</secret>` marker in the goal rather than the password. That
 * matters: hashing is one-way, but a password drawn from a small space is
 * recoverable from a digest, and this is a column a read endpoint may serve.
 *
 * What is no longer caught is a project preamble edited under the test. That is
 * the accepted cost, and the panel's Clear is the answer to it.
 * @param {MemoryInputs} inputs
 */
export function fingerprint(inputs) {
  return createHash('sha256').update(canonicalJson(canonicalInputs(inputs))).digest('hex');
}

/**
 * What one run is given, decided from the stored row and the run's resolved
 * inputs. The one place a run's memory is settled, so there is no second path
 * that could supply something the panel does not show.
 *
 * `supplied` is the notebook itself, and it is the only value: the agent words
 * it (`run_memory.to_prompt`) and the panel renders it. A server-side rendering
 * beside it would be a second copy that has to keep agreeing with the first, and
 * the story's promise is that there is no memory visible only to the model.
 *
 * `withheld` says why nothing was supplied when something was there. There is
 * one reason, `'inputs_changed'`: the notebook was written under inputs this run
 * does not have. An empty notebook is not withheld — nothing learned yet is the
 * ordinary state of a new test and of one just cleared, and the run feed must
 * not report it as advice being kept back.
 *
 * **A run that did not pass changes nothing here.** An earlier draft withheld
 * after a failure, on the reasoning that failure is the corrective signal for a
 * lesson gone stale. It is not: the commonest reason a QA test fails is that it
 * found the bug it exists to find, and withholding there makes the next run cold
 * — which, under "cold replaces", throws away every good lesson to punish a
 * failure none of them caused. A wrong lesson is removed from the panel, or the
 * notebook is cleared.
 *
 * `fingerprint` is returned whatever happens, because it is what the run carries
 * to the conditional write. A run that was given nothing is precisely the run
 * that has earned the right to replace the notebook.
 * @param {{ stored: StoredMemory | null, inputs: MemoryInputs }} request
 */
export function memoryFor({ stored, inputs }) {
  const fp = fingerprint(inputs);
  const nothing = { fingerprint: fp, used: false, supplied: null, withheld: null };
  if (!stored) return nothing;

  // The row's own fingerprint records what the last writer knew; this
  // comparison is what the current run knows. Trusting the row over the
  // comparison is how advice about a different app reaches a prompt while every
  // column still looks correct.
  if (stored.fingerprint !== fp) return { ...nothing, withheld: 'inputs_changed' };

  const learned = stored.learned || null;
  if (!learned || !count(learned)) return nothing;
  return { fingerprint: fp, used: true, supplied: learned, withheld: null };
}

/**
 * Whether a finished run may write the memory row.
 *
 * Two runs of one test can be in flight together, and a test can be edited while
 * a run is going. The run carries the fingerprint it *started* with, and the
 * write is refused when the test's current fingerprint differs. A blind upsert
 * lets a run that started before an edit teach a memory keyed to the post-edit
 * inputs — and nothing about that is visible afterwards, because the row looks
 * freshly learned while its advice describes an app the test no longer points at.
 * @param {{ runFingerprint: string, currentFingerprint: string }} write
 */
export function mayStore({ runFingerprint, currentFingerprint }) {
  return runFingerprint === currentFingerprint;
}

/** @param {Notebook} learned */
function count(learned) {
  return Object.values(learned).reduce(
    (total, section) => total + (Array.isArray(section) ? section.length : 0),
    0
  );
}

/**
 * The two inputs, in the one shape the hash reads them in.
 * @param {MemoryInputs} inputs
 * @returns {Record<string, unknown>}
 */
function canonicalInputs(inputs) {
  return {
    goal: String(inputs.goal ?? '').trim(),
    start_url: normalizeUrl(inputs.start_url),
  };
}

/** JSON with object keys sorted at every depth, so key order cannot reach the
 * hash — otherwise a run learns memory the very next identical run cannot read. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The storage rule, applied to the fingerprint too: scheme and host lowercased,
 * default port dropped, query and fragment removed. They carry tokens and
 * unstable ids, and a campaign parameter must not read as a different test. */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}
