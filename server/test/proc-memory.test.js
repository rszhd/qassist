// @ts-check
// US-024: the number the memory watchdog kills a run on.
//
// Asserted against a fake /proc rather than real processes, because the failure
// this guards is a plausible-looking number. The result is only ever compared
// against one threshold, so a unit slip — kB read as bytes, or as pages — is
// off by 1024x or 4x and still looks like a memory reading. Nothing downstream
// contradicts it: too high kills healthy runs (which is how US-006 landed), too
// low and the watchdog silently stops guarding the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processTree } from '../src/procMemory.js';

const KB = 1024;
const MB = 1024 * 1024;
const PAGE = 4096;

/**
 * Write one pid into a fake /proc. `pss` in kB as the kernel reports it, or
 * null for a pid whose smaps_rollup does not exist.
 * @param {string} root
 * @param {{ pid: number, ppid: number, rssPages: number, pssKb?: number | null, comm?: string }} p
 */
function writeProc(root, { pid, ppid, rssPages, pssKb = null, comm = 'chrome' }) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  // stat: pid (comm) state ppid ... with rss at field 24, i.e. index 21 of
  // what remains after the last ')'.
  const after = ['S', String(ppid), ...Array(19).fill('0'), String(rssPages), '0'];
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) ${after.join(' ')}\n`);
  if (pssKb !== null) {
    fs.writeFileSync(
      path.join(dir, 'smaps_rollup'),
      `00400000-7fff00000000 ---p 00000000 00:00 0 [rollup]\n` +
        `Rss:              ${rssPages * 4} kB\n` +
        `Pss:              ${pssKb} kB\n` +
        `Shared_Clean:     0 kB\n`
    );
  }
}

/** @param {(root: string) => void} build */
function fakeProc(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-proc-'));
  build(root);
  return root;
}

test('Pss is read as kilobytes, the unit the kernel writes it in', () => {
  // The whole story in one number: `Pss: 1024 kB` is one mebibyte. Read as
  // bytes it is 1 kB and no run ever trips the limit; read as pages it is
  // 4 MB and healthy runs die.
  const root = fakeProc((r) => writeProc(r, { pid: 100, ppid: 1, rssPages: 0, pssKb: 1024 }));
  assert.equal(processTree(100, root).bytes, 1 * MB);
});

test('PSS replaces RSS for a pid, it never adds to it', () => {
  // Both numbers are on disk for every process. Summing them is the shape of
  // mistake that survives review, because the total still moves with the load.
  const root = fakeProc((r) =>
    writeProc(r, { pid: 100, ppid: 1, rssPages: 500, pssKb: 100 })
  );
  const { bytes, fellBack } = processTree(100, root);
  assert.equal(bytes, 100 * KB);
  assert.notEqual(bytes, 100 * KB + 500 * PAGE);
  assert.deepEqual(fellBack, [], 'a readable pid is not a fallback');
});

test('the tree total is the sum of per-process PSS, not of RSS', () => {
  // Four Chromium processes sharing heavily: 1600 pages of RSS each (25 MB),
  // but only 5 MB apiece once the shared pages are divided among the sharers.
  const root = fakeProc((r) => {
    writeProc(r, { pid: 100, ppid: 1, rssPages: 6400, pssKb: 5 * 1024, comm: 'python' });
    for (const pid of [101, 102, 103]) {
      writeProc(r, { pid, ppid: 100, rssPages: 6400, pssKb: 5 * 1024 });
    }
  });
  const { bytes, pids } = processTree(100, root);
  assert.equal(bytes, 20 * MB);
  assert.equal(pids.length, 4);
});

test('an unreadable smaps_rollup falls back to that pid RSS, and says so', () => {
  // The fallback is honest but not free: the total is then neither metric. The
  // caller has to be able to tell, because the renderer is the biggest sharer
  // and is exactly where a substituted RSS overstates by the most.
  const root = fakeProc((r) => {
    writeProc(r, { pid: 100, ppid: 1, rssPages: 256, pssKb: 512 });
    writeProc(r, { pid: 101, ppid: 100, rssPages: 256, pssKb: null });
  });
  const { bytes, fellBack } = processTree(100, root);
  assert.equal(bytes, 512 * KB + 256 * PAGE);
  assert.deepEqual(fellBack, [101]);
});

test('a malformed Pss line is a fallback, not a zero', () => {
  // Reading no number and counting it as 0 MB is the one failure that removes
  // the guard entirely: an unparsed tree measures nothing and never trips.
  const root = fakeProc((r) => {
    writeProc(r, { pid: 100, ppid: 1, rssPages: 256, pssKb: null });
    fs.writeFileSync(path.join(r, '100', 'smaps_rollup'), 'Rss: 1024 kB\nPss:\n');
  });
  const { bytes, fellBack } = processTree(100, root);
  assert.equal(bytes, 256 * PAGE);
  assert.deepEqual(fellBack, [100]);
});

test('only the root pid descendants are counted, to any depth', () => {
  // The tree is also the kill list, so a pid that gets counted gets SIGKILLed.
  // Counting a sibling would both inflate the number and kill another run.
  const root = fakeProc((r) => {
    writeProc(r, { pid: 100, ppid: 1, rssPages: 0, pssKb: 10 * 1024, comm: 'python' });
    writeProc(r, { pid: 101, ppid: 100, rssPages: 0, pssKb: 20 * 1024 });
    writeProc(r, { pid: 102, ppid: 101, rssPages: 0, pssKb: 30 * 1024 }); // grandchild
    writeProc(r, { pid: 900, ppid: 1, rssPages: 0, pssKb: 900 * 1024, comm: 'other-run' });
  });
  const { bytes, pids } = processTree(100, root);
  assert.equal(bytes, 60 * MB);
  assert.deepEqual(pids.sort((a, b) => a - b), [100, 101, 102]);
});

test('a pid that exits mid-scan contributes nothing and does not throw', () => {
  const root = fakeProc((r) => {
    writeProc(r, { pid: 100, ppid: 1, rssPages: 0, pssKb: 8 * 1024 });
    fs.mkdirSync(path.join(r, '101')); // listed, no stat: gone between readdir and read
  });
  const { bytes, pids } = processTree(100, root);
  assert.equal(bytes, 8 * MB);
  assert.deepEqual(pids, [100]);
});

test('a root pid that is already gone measures zero, not everything', () => {
  const root = fakeProc((r) => writeProc(r, { pid: 900, ppid: 1, rssPages: 0, pssKb: 900 * 1024 }));
  assert.deepEqual(processTree(100, root), { bytes: 0, pids: [], fellBack: [] });
});

test('an unreadable /proc measures zero rather than throwing in the watchdog', () => {
  assert.deepEqual(processTree(100, '/nonexistent/proc'), {
    bytes: 0,
    pids: [],
    fellBack: [],
  });
});
