// @ts-check
// US-048 — assertion-first spec, part 1: THE NAME → PATH GATE.
//
// A project's fixtures are the whitelist handed to browser-use as
// `available_file_paths`, and that list is the only thing standing between an
// agent that can be talked into calling `upload_file` (or `read_file` — same
// list gates both, tools/service.py:865 and :1785) and a file-read primitive
// pointed at the container. This file pins the half that decides what a name
// may become on disk; fixture-whitelist.test.js pins the half that decides
// whose files reach the child.
//
// The failure this file exists to catch is a *quiet* one. Every assertion in
// part 2 stays green while this gate is wrong: fixtures upload, runs start, the
// agent attaches files, the report renders. The only difference is that
// `POST /api/projects/p/fixtures?filename=../../.env` wrote to the app root.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVIEWER — the decisions this file encodes. Argue with any of them; the
// implementation has not been written yet, which is the point.
//
//   D1   ALLOWLIST THE CHARACTER CLASS, don't denylist traversal. A denylist
//        is a list of the spellings we thought of — `..`, `%2e%2e`, `....//`,
//        `..\`, a null byte, U+202E — and US-042 is the standing reminder that
//        the spelling table is always longer than it looks. An allowlist makes
//        the whole table fall out of one rule: a separator cannot be expressed,
//        so no traversal can be either.
//
//   D2   The class is `\p{L}\p{N}` plus dot, underscore, space and dash, first
//        character alphanumeric, NFC-normalized, ≤255 bytes. Unicode letters
//        rather than ASCII because `Résumé.pdf` and `简历.pdf` are real files a
//        real customer uploads, and refusing them to save a regex is the kind
//        of parochial cap that makes a tool feel foreign. NFC because macOS
//        hands us NFD and the two spellings are the same file to a human, so
//        without normalization the uniqueness constraint sees two rows and the
//        filesystem sees one.
//        [REVIEW: unicode vs ASCII-only. ASCII-only is a smaller surface and I
//        would not fight hard for unicode if you want the narrower gate.]
//
//   D3   Leading dot is refused, which is what makes `.env`, `.git`,
//        `.ssh/config` unnameable rather than merely un-traversable. Trailing
//        dot and trailing space are refused too: Windows silently strips both,
//        so `cv.pdf ` and `cv.pdf` are one file there and two rows here.
//
//   D4   TWO LAYERS, and the second is not redundant. `normalizeFilename` is
//        the gate; `fixturePath` re-asserts containment with `path.resolve`
//        before returning. A caller cannot obtain a path without passing both —
//        there is deliberately no exported `join(fixtureDir(id), name)`. The
//        second layer is what a future loosening of D2 runs into.
//
//   D5   `path.join` vs `path.resolve` is the trap worth naming. `join(dir,
//        '/etc/passwd')` yields `dir/etc/passwd` — contained, harmless, and a
//        containment test written against `join` therefore PASSES for an
//        absolute-path input while a caller that uses `resolve` is wide open.
//        So the containment assertion below is written against `resolve`, and
//        the absolute-path spelling is in the reject table on its own account.
//
//   D6   Uniqueness within a project is CASE-INSENSITIVE. `CV.pdf` and `cv.pdf`
//        are two rows and one file on a case-insensitive volume, and the row
//        that loses is a fixture whose bytes silently became someone else's.
//        Enforced as a `lower(filename)` unique index, asserted here only as
//        the normalizer exposing the key (`fixtureKey`) the index is built on.
//
//   D7   The quota check is pure and takes BYTES ALREADY STORED plus INCOMING,
//        so it is callable before the write. A quota enforced after the write
//        has already filled the disk it exists to protect.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
  normalizeFilename,
  fixtureKey,
  fixtureDir,
  fixturePath,
  withinQuota,
  fixturesDirConflict,
} = await import('../src/fixtures.js');

const PROJECT = '11111111-2222-3333-4444-555555555555';

// --- G1: the reject table, on RAW spellings ---------------------------------

// Every entry is a string that could arrive as `?filename=…`. They are asserted
// raw rather than pre-cleaned, because a gate that only sees cleaned input is a
// gate that is never tested. The comment on each is what it would have written
// to had the gate let it through.
const REJECTED = [
  ['../../.env', 'the app root, where the API token lives'],
  ['../.env', 'one level up'],
  ['..', 'the parent directory itself'],
  ['.', 'the fixture directory itself'],
  ['/etc/passwd', 'absolute — contained by join, escaping under resolve (D5)'],
  ['/app/.env', 'absolute, and a file that really exists in the image'],
  ['..\\..\\.env', 'backslash: harmless on Linux, a separator on Windows'],
  ['....//.env', 'survives a naive single-pass strip of ".."'],
  ['%2e%2e%2f.env', 'percent-encoded, in case a future transport stops decoding'],
  ['..%2F.env', 'half-decoded, the shape a double-decode bug produces'],
  ['a/b.pdf', 'a separator anywhere at all'],
  ['cv.pdf\u0000.png', 'null byte — truncates at the syscall, not in JS'],
  ['cv\n.pdf', 'control character'],
  ['\u202Efdp.exe', 'RTL override: renders as "exe.pdf" in the UI'],
  ['.env', 'leading dot (D3)'],
  ['.gitconfig', 'leading dot'],
  ['cv.pdf ', 'trailing space — Windows strips it (D3)'],
  ['cv.', 'trailing dot — Windows strips it (D3)'],
  ['', 'empty'],
  ['   ', 'whitespace only'],
  ['-rf', 'leading dash: not alphanumeric, and an argument-shaped name'],
  [`${'a'.repeat(300)}.pdf`, 'over 255 bytes'],
  [`${'\u00e9'.repeat(200)}.pdf`, '200 chars but over 255 BYTES once encoded'],
];

for (const [raw, why] of REJECTED) {
  test(`refuses ${JSON.stringify(raw)} — ${why}`, () => {
    const result = normalizeFilename(raw);
    assert.ok('error' in result, `${JSON.stringify(raw)} was accepted`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, 'the refusal has to say something');
  });
}

// --- G2: the accept table ---------------------------------------------------

const ACCEPTED = [
  'cv.pdf',
  'Resume 2026.docx',
  'passport-front.jpg',
  'data_import.csv',
  'archive.tar.gz',
  'a',
  'R\u00e9sum\u00e9.pdf', // D2: unicode letters (composed)
  '\u7b80\u5386.pdf',
  '2026-tax-return.pdf',
];

for (const raw of ACCEPTED) {
  test(`accepts ${JSON.stringify(raw)}`, () => {
    const result = normalizeFilename(raw);
    assert.ok(!('error' in result), `${JSON.stringify(raw)} was refused: ${/** @type {any} */ (result).error}`);
    assert.equal(/** @type {any} */ (result).filename, raw.normalize('NFC'));
  });
}

test('an accepted name is returned NFC-normalized, not as sent (D2)', () => {
  // "é" as e + combining acute — what macOS hands us. Same file, same human
  // reading, and it must not become a second row.
  const decomposed = 'Re\u0301sume\u0301.pdf';
  const composed = 'R\u00e9sum\u00e9.pdf';
  const result = normalizeFilename(decomposed);
  assert.ok(!('error' in result));
  assert.equal(result.filename, composed, 'stored composed regardless of how it arrived');
  assert.notEqual(decomposed, composed, 'the two spellings really are different strings');
});

// --- G3: uniqueness key (D6) -------------------------------------------------

test('the uniqueness key folds case, so CV.pdf and cv.pdf collide', () => {
  assert.equal(fixtureKey('CV.pdf'), fixtureKey('cv.pdf'));
  assert.notEqual(fixtureKey('cv.pdf'), fixtureKey('cv2.pdf'));
});

test('the uniqueness key folds the NFC normalization too', () => {
  assert.equal(fixtureKey('Re\u0301sume\u0301.pdf'), fixtureKey('R\u00e9sum\u00e9.pdf'));
});

// --- G4: containment, asserted with resolve (D4, D5) -------------------------

test('every accepted name resolves strictly inside the project directory', () => {
  const dir = path.resolve(fixtureDir(PROJECT));
  for (const raw of ACCEPTED) {
    const result = fixturePath(PROJECT, raw);
    assert.ok(!('error' in result), `${raw}: ${/** @type {any} */ (result).error}`);
    const resolved = path.resolve(/** @type {any} */ (result).path);
    assert.ok(
      resolved.startsWith(dir + path.sep),
      `${raw} resolved to ${resolved}, outside ${dir}`
    );
    assert.equal(path.dirname(resolved), dir, 'directly inside — no subdirectory can be named');
  }
});

test('every rejected name yields no path at all', () => {
  // The structural claim: there is no way to get a path without passing the
  // gate (D4). Not "the path is safe" — no path is handed back.
  for (const [raw] of REJECTED) {
    const result = fixturePath(PROJECT, raw);
    assert.ok('error' in result, `${JSON.stringify(raw)} produced a path`);
    assert.equal(/** @type {any} */ (result).path, undefined);
  }
});

test('two projects never share a directory', () => {
  const other = '99999999-8888-7777-6666-555555555555';
  assert.notEqual(path.resolve(fixtureDir(PROJECT)), path.resolve(fixtureDir(other)));
  const mine = /** @type {any} */ (fixturePath(PROJECT, 'cv.pdf')).path;
  const theirs = /** @type {any} */ (fixturePath(other, 'cv.pdf')).path;
  assert.notEqual(mine, theirs, 'same filename, different projects, different files');
});

test('a project id that is not a uuid never becomes a directory', () => {
  // The id reaches this from a resolved row, never from a request param — but
  // the gate must not depend on that being true forever.
  for (const bad of ['../..', 'a/b', '', '.', '/etc']) {
    const result = fixturePath(bad, 'cv.pdf');
    assert.ok('error' in result, `project id ${JSON.stringify(bad)} produced a path`);
  }
});

// --- G5: the quota, before the write (D7) ------------------------------------

test('a file over the per-file cap is refused', () => {
  const verdict = withinQuota({ storedBytes: 0, incomingBytes: 999 * 1024 * 1024 });
  assert.ok('error' in verdict);
  assert.match(verdict.error, /\d/, 'the refusal names a number, not just "too large"');
});

test('a file that fits alone but not beside what is stored is refused', () => {
  // The case a per-file-only cap misses entirely: fifty files each under the
  // per-file limit is still fifty files.
  const cap = 50 * 1024 * 1024;
  const verdict = withinQuota({ storedBytes: cap - 1024, incomingBytes: 2048 });
  assert.ok('error' in verdict, 'the project quota is a separate check from the per-file cap');
});

test('an ordinary upload passes', () => {
  assert.ok(!('error' in withinQuota({ storedBytes: 0, incomingBytes: 64 * 1024 })));
});

test('zero bytes is refused', () => {
  // browser-use refuses a 0-byte upload at the action (tools/service.py:914),
  // so accepting one here buys the user a run that fails deep in the agent
  // with "the file may not have been saved correctly".
  assert.ok('error' in withinQuota({ storedBytes: 0, incomingBytes: 0 }));
});

// --- G6: the boot guard against retention (AC #4) ----------------------------

test('a fixtures dir inside the artifacts dir is refused at boot', () => {
  // retention.js:48 prunes exactly "a uuid-named directory under ARTIFACTS_DIR
  // older than the cutoff", and fixture directories are uuid-named (they are
  // project ids). So the natural-looking layout deletes a customer's fixtures
  // on day seven — AC #4's failure arriving by configuration rather than by
  // code, which no test of the sweep itself would catch.
  const conflict = fixturesDirConflict('/data/runs/fixtures', '/data/runs');
  assert.ok(conflict, 'nested under the artifacts dir must not be allowed to boot');
  assert.match(conflict.error, /ARTIFACT|retention|artifacts/i, 'the message says why');
});

test('the same directory for both is refused', () => {
  assert.ok(fixturesDirConflict('/data/runs', '/data/runs'));
});

test('sibling directories are fine', () => {
  assert.equal(fixturesDirConflict('/data/fixtures', '/data/runs'), null);
});

test('a prefix that is not a path boundary is fine', () => {
  // /data/runs-fixtures starts with /data/runs as a STRING but is not inside
  // it. A naive startsWith refuses a legitimate layout here, and — the same bug
  // pointed the other way — accepts a nested one elsewhere.
  assert.equal(fixturesDirConflict('/data/runs-fixtures', '/data/runs'), null);
});
