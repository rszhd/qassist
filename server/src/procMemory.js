// @ts-check
import fs from 'node:fs';

// A run is one Python parent plus a dozen-odd Chromium processes, so memory
// accounting must cover the whole tree. Walk /proc (Linux-only, like our
// Docker base image); the pid list doubles as the kill list.
//
// The metric is PSS, not summed RSS (US-024). Chromium's 7-8 processes share a
// large amount of memory and RSS counts every shared page once per sharer, so
// summing it reports ~1.7x what the machine actually pays — a number that has
// to be re-tuned for every feature that adds a process and cannot be used to
// size a host. PSS divides each shared page by the number of processes sharing
// it, so the tree total is what the run costs.

// smaps_rollup and smaps report in kB, always, regardless of page size.
const SMAPS_UNIT_BYTES = 1024;
// `stat`'s rss field is in pages, and the fallback path has no sysconf to ask.
// 4096 on every architecture this ships to; wrong only on a 16K-page kernel,
// where it under-reports and the watchdog errs towards letting a run live.
const PAGE_BYTES = 4096;

/**
 * Proportional set size for one pid, in bytes, or null when the kernel will
 * not tell us. `smaps_rollup` is the kernel's own per-process total, so this
 * is one small read rather than a walk of every mapping — but it is absent
 * before Linux 4.14 and unreadable without ptrace access to the target.
 * @param {string} procRoot
 * @param {number} pid
 * @returns {number | null}
 */
function pssBytes(procRoot, pid) {
  let rollup;
  try {
    rollup = fs.readFileSync(`${procRoot}/${pid}/smaps_rollup`, 'utf8');
  } catch {
    return null;
  }
  const match = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup);
  return match ? Number(match[1]) * SMAPS_UNIT_BYTES : null;
}

/**
 * Every pid under `procRoot` mapped to its parent and its RSS.
 * @param {string} procRoot
 * @returns {Map<number, { ppid: number, rssBytes: number }>}
 */
function readProcs(procRoot) {
  const procs = new Map();
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return procs;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`${procRoot}/${name}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens; parse after the last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.set(Number(name), {
        ppid: Number(rest[1]),
        rssBytes: Number(rest[21]) * PAGE_BYTES,
      });
    } catch {
      /* process exited mid-scan */
    }
  }
  return procs;
}

/**
 * Memory used by `rootPid` and its descendants, and the pids it summed.
 *
 * `fellBack` names the pids whose PSS was unreadable and whose RSS was
 * substituted. That substitution makes the total neither metric — it
 * over-reports, by the shared pages of whichever process could not be read —
 * so the caller says so rather than reporting a mixed number as PSS.
 *
 * @param {number} rootPid
 * @param {string} [procRoot]
 * @returns {{ bytes: number, pids: number[], fellBack: number[] }}
 */
export function processTree(rootPid, procRoot = '/proc') {
  const procs = readProcs(procRoot);
  const pids = [];
  const fellBack = [];
  let bytes = 0;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    const p = procs.get(pid);
    if (!p) continue;
    pids.push(pid);
    const pss = pssBytes(procRoot, pid);
    if (pss === null) {
      fellBack.push(pid);
      bytes += p.rssBytes;
    } else {
      bytes += pss;
    }
    for (const [childPid, c] of procs) {
      if (c.ppid === pid) stack.push(childPid);
    }
  }
  return { bytes, pids, fellBack };
}
