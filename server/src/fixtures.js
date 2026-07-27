// @ts-check
// Project fixtures (US-048): the files a project's tests may attach, and the
// gate that decides what a name may become on disk.
//
// This module is the security boundary, not a storage helper. The paths it
// produces are handed to browser-use as `available_file_paths`, which gates
// `upload_file` on exact membership AND gates `read_file`'s external reads on
// the same list. An entry nobody meant to put there is a file the agent can be
// argued into reading back into its own context — `.env` included. So the rule
// is that a caller cannot obtain a path without passing the gate: there is
// deliberately no exported join of a directory and a name.
//
// Correctness-critical (backlog/correctness-critical.md). The spec is
// test/fixture-path.test.js and test/fixture-whitelist.test.js, both written
// and reviewed before this file existed.
import fs from 'node:fs';
import path from 'node:path';
import { isUuid } from './db.js';
import { FIXTURES_DIR, FIXTURE_MAX_BYTES, FIXTURE_PROJECT_QUOTA_BYTES } from './config.js';

// Allowlist, not a denylist of traversal spellings. A denylist is a list of the
// spellings we thought of — `..`, `%2e%2e`, `....//`, `..\`, a null byte, an
// RTL override — and US-042 is the standing reminder that the table is always
// longer than it looks. Here a separator simply cannot be expressed, so no
// traversal can be either, and the whole table falls out of one rule.
//
// Unicode letters and digits rather than ASCII because `Résumé.pdf` and
// `简历.pdf` are files real customers upload, and refusing them to save a regex
// is a parochial cap on a product people outside one alphabet use. Format
// characters (`\p{Cf}`, which is what the RTL override is) are letters to
// nobody and are excluded by construction.
const FILENAME = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,254}$/u;

// Windows silently strips both, so `cv.pdf ` and `cv.pdf` are one file there
// and two rows here — a collision our own uniqueness check would never see.
const TRAILING = /[. ]$/;

// The filesystem's limit is bytes, not characters: 200 accented characters is
// 204 characters and 404 bytes, and only one of those numbers matters to the
// syscall that fails.
const MAX_FILENAME_BYTES = 255;

/**
 * Validate a fixture filename as it arrives from a request. Returns
 * `{ error }` or `{ filename }` — NFC-normalized, which is the form stored and
 * the form written to disk.
 *
 * NFC because macOS hands us `é` decomposed (e + combining acute) and Linux
 * composed. They are the same file to every human and two different strings to
 * every byte comparison, so normalizing at the door is what stops one project
 * holding two fixtures that are indistinguishable in the UI.
 * @param {unknown} raw
 * @returns {{ error: string } | { filename: string }}
 */
export function normalizeFilename(raw) {
  if (typeof raw !== 'string' || !raw) return { error: 'a filename is required' };
  const filename = raw.normalize('NFC');
  if (Buffer.byteLength(filename, 'utf8') > MAX_FILENAME_BYTES) {
    return { error: `filename is longer than ${MAX_FILENAME_BYTES} bytes` };
  }
  if (!FILENAME.test(filename)) {
    return {
      error:
        'filename must start with a letter or digit and contain only letters, digits, ' +
        'spaces, dots, dashes and underscores',
    };
  }
  if (TRAILING.test(filename)) return { error: 'filename must not end with a dot or a space' };
  return { filename };
}

/**
 * The key a project's filenames are unique on: case-folded and NFC-normalized.
 * Stored as its own column (014) rather than expressed as a functional index —
 * the migration says why.
 * @param {string} filename
 */
export function fixtureKey(filename) {
  return filename.normalize('NFC').toLowerCase();
}

/**
 * A project's fixture directory. Throws on anything that is not a uuid, which
 * is defence in depth rather than validation: the id reaches this off a
 * resolved row every time, and a day where it doesn't should be loud.
 * @param {string} projectId
 */
export function fixtureDir(projectId) {
  if (!isUuid(projectId)) throw new TypeError(`fixtureDir: not a project id: ${projectId}`);
  return path.join(FIXTURES_DIR, projectId);
}

/**
 * The on-disk path for one fixture, or `{ error }`. Every caller goes through
 * here; nothing exports a way to build the path without the gate.
 *
 * The containment re-check is not redundant with `normalizeFilename`. It is
 * what a future loosening of the character class runs into, and it is written
 * against `path.resolve` deliberately: `path.join(dir, '/etc/passwd')` yields
 * `dir/etc/passwd` — contained, harmless, and a containment test written
 * against `join` therefore passes for an absolute-path input while a caller
 * that resolves is wide open.
 * @param {string} projectId
 * @param {unknown} rawFilename
 * @returns {{ error: string } | { path: string, filename: string }}
 */
export function fixturePath(projectId, rawFilename) {
  if (!isUuid(projectId)) return { error: 'not found' };
  const named = normalizeFilename(rawFilename);
  if ('error' in named) return named;
  const dir = path.resolve(fixtureDir(projectId));
  const full = path.resolve(dir, named.filename);
  if (path.dirname(full) !== dir) return { error: 'invalid filename' };
  return { path: full, filename: named.filename };
}

/**
 * The whitelist a run is spawned with: this project's fixtures, absolute, in a
 * stable order.
 *
 * Read off the directory rather than assembled from the `fixtures` table on
 * purpose. The rows are metadata for the UI; the thing that decides what a
 * browser may open has to be the thing that actually exists, and where the two
 * disagree — a half-finished delete, a restored volume — disk is the honest
 * answer. Synchronous because `startRun` is, and it is one readdir per spawn.
 *
 * A name on disk that would not pass the gate today is dropped rather than
 * offered, so loosening or tightening the gate can never strand a file the
 * agent may open but a user can no longer delete.
 * @param {string | null | undefined} projectId
 * @returns {string[]}
 */
export function fixturePathsFor(projectId) {
  if (!projectId || !isUuid(projectId)) return [];
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(fixtureDir(projectId), { withFileTypes: true });
  } catch {
    return []; // no fixtures were ever uploaded for this project
  }
  const paths = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const resolved = fixturePath(projectId, entry.name);
    if ('error' in resolved) continue;
    paths.push(resolved.path);
  }
  return paths.sort();
}

/** Total bytes a project is storing, counted off disk for the same reason. */
export function projectUsageBytes(projectId) {
  let total = 0;
  for (const file of fixturePathsFor(projectId)) {
    try {
      total += fs.statSync(file).size;
    } catch {
      /* vanished under us */
    }
  }
  return total;
}

/**
 * Whether an upload fits, checked BEFORE the body is committed to disk — a
 * quota enforced afterwards has already filled the disk it exists to protect.
 * @param {{ storedBytes: number, incomingBytes: number }} sizes
 * @returns {{ error: string } | { ok: true }}
 */
export function withinQuota({ storedBytes, incomingBytes }) {
  if (!incomingBytes) {
    // browser-use refuses a 0-byte upload at the action itself, so accepting one
    // here buys the user a run that dies deep in the agent with "the file may
    // not have been saved correctly" — a fixture problem wearing an agent bug's
    // clothes.
    return { error: 'the file is empty' };
  }
  if (incomingBytes > FIXTURE_MAX_BYTES) {
    return { error: `file is larger than the ${mb(FIXTURE_MAX_BYTES)} MB limit for one fixture` };
  }
  if (storedBytes + incomingBytes > FIXTURE_PROJECT_QUOTA_BYTES) {
    return {
      error:
        `this project's fixtures would exceed its ${mb(FIXTURE_PROJECT_QUOTA_BYTES)} MB quota ` +
        `(${mb(storedBytes)} MB stored) — delete a file first`,
    };
  }
  return { ok: true };
}

/** Bytes as megabytes, at one decimal place, for a message a human reads. */
function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** Remove one project's fixture directory — its project was deleted. */
export function removeProjectFixtures(projectId) {
  if (!isUuid(projectId)) return;
  fs.rmSync(fixtureDir(projectId), { recursive: true, force: true });
}

/**
 * Whether FIXTURES_DIR and ARTIFACTS_DIR overlap, which boot refuses.
 *
 * Not a fussy check. `retention.js` prunes exactly "a uuid-named directory
 * under ARTIFACTS_DIR older than the cutoff", and a fixture directory is
 * uuid-named — it is a project id. So a plausible-looking layout deletes a
 * customer's fixtures on day seven, and it does so with no bug anywhere in the
 * sweep: US-048's "fixtures survive artifact retention" fails purely by
 * configuration, which is the kind of failure no test of the sweep would catch.
 * @param {string} fixturesDir
 * @param {string} artifactsDir
 * @returns {{ error: string } | null}
 */
export function fixturesDirConflict(fixturesDir, artifactsDir) {
  const fixtures = path.resolve(fixturesDir);
  const artifacts = path.resolve(artifactsDir);
  // Compared on a path boundary, so `/data/runs-fixtures` is not "inside"
  // `/data/runs` — the naive startsWith refuses that legitimate layout, and the
  // same bug pointed the other way accepts a genuinely nested one.
  const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  if (contains(artifacts, fixtures) || contains(fixtures, artifacts)) {
    return {
      error:
        `FIXTURES_DIR (${fixtures}) must not overlap ARTIFACTS_DIR (${artifacts}): ` +
        'artifact retention deletes uuid-named directories there, and a fixture directory ' +
        'is named after its project',
    };
  }
  return null;
}
