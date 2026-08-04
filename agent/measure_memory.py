"""Measure what a run's process tree really costs, RSS and PSS side by side.

US-004 sized `MAX_RUN_MEMORY_MB` by summing `/proc/<pid>/stat` RSS over the
tree; US-024 showed that counts Chromium's shared pages once per process and
replaced the metric with PSS. This is the probe those numbers came from, kept
so the next re-baseline is a command rather than a rebuild.

It launches the same `BrowserProfile` as `run_agent.py`, navigates, and runs
the real `screencast()` coroutine with a recorder attached — no LLM, so a
measurement costs nothing and is repeatable. Both metrics are sampled together
over the same tree, which is what makes the ratio between them meaningful.

Runs inside the app image (needs browser_use and Chromium):

    docker run --rm --entrypoint sh -v "$PWD/agent:/src:ro" -w /src qassist:latest \\
      -c '/opt/venv/bin/python measure_memory.py --url https://try.discourse.org'

`--no-record` reproduces the QA_RECORD=0 row of the same table.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
import time

PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
MB = 1024 * 1024


def _stat_fields(pid: int, proc_root: str = "/proc") -> list[str] | None:
    try:
        with open(f"{proc_root}/{pid}/stat", encoding="utf-8") as f:
            stat = f.read()
    except OSError:
        return None
    # comm (field 2) may contain spaces and parens; parse after the LAST ')'.
    return stat[stat.rindex(")") + 2 :].split(" ")


def stat_rss_bytes(pid: int, proc_root: str = "/proc") -> int | None:
    fields = _stat_fields(pid, proc_root)
    return None if fields is None else int(fields[21]) * PAGE_SIZE


def pss_bytes(pid: int, proc_root: str = "/proc") -> int | None:
    """Proportional set size: shared pages divided by the number of sharers.

    `smaps_rollup` is the kernel's own per-process total, so this is one small
    read rather than a walk of every mapping. Absent before Linux 4.14 and
    unreadable without ptrace access to the target. Reported in kB, always —
    the same unit trap `server/src/procMemory.js` is asserted against, and this
    is the instrument the server's limit gets baselined from.
    """
    try:
        with open(f"{proc_root}/{pid}/smaps_rollup", encoding="utf-8") as f:
            for line in f:
                if line.startswith("Pss:"):
                    parts = line.split()
                    if len(parts) >= 3 and parts[2] == "kB":
                        return int(parts[1]) * 1024
                    return None
    except (OSError, ValueError):
        return None
    return None


def _ppid(pid: int, proc_root: str = "/proc") -> int | None:
    fields = _stat_fields(pid, proc_root)
    return None if fields is None else int(fields[1])


def _comm(pid: int) -> str:
    """Short name. Chromium rewrites argv[0] of its helpers to the profile dir,
    so the useful label is `comm` plus whichever `--type=` it was spawned as.
    """
    try:
        with open(f"/proc/{pid}/comm", encoding="utf-8") as f:
            name = f.read().strip()
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = f.read().split(b"\0")
    except OSError:
        return "?"
    for arg in argv:
        if arg.startswith(b"--type="):
            return f"{name} ({arg[len(b'--type=') :].decode('utf-8', 'replace')})"
    return name


def sample(root_pid: int) -> list[tuple[int, str, int, int | None]]:
    """(pid, name, rss, pss) for the root pid and every descendant."""
    children: dict[int, list[int]] = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        parent = _ppid(int(name))
        if parent is not None:
            children.setdefault(parent, []).append(int(name))

    rows = []
    stack = [root_pid]
    while stack:
        pid = stack.pop()
        rss = stat_rss_bytes(pid)
        if rss is None:
            continue  # exited mid-scan
        rows.append((pid, _comm(pid), rss, pss_bytes(pid)))
        stack.extend(children.get(pid, []))
    return rows


async def probe(url: str, seconds: float, interval: float, record: bool) -> None:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import run_agent  # noqa: E402  — after sys.path, and it pulls in Chromium deps
    from browser_use import BrowserSession  # noqa: E402
    from browser_use.browser.profile import BrowserProfile  # noqa: E402

    profile = BrowserProfile(
        headless=True,
        chromium_sandbox=False,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--process-per-site",
            "--renderer-process-limit=3",
            "--js-flags=--max-old-space-size=256",
            "--disable-extensions",
            "--mute-audio",
            "--disable-background-networking",
            "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
        ],
    )

    tmp = tempfile.mkdtemp(prefix="qa-memprobe-")
    recorder = (
        run_agent.SessionRecorder(os.path.join(tmp, run_agent.RECORD_FILENAME))
        if record
        else None
    )

    session = BrowserSession(browser_profile=profile)
    stop_event = asyncio.Event()
    watch_event = asyncio.Event()  # left clear: no viewer attached, as in the story
    peak_rss = 0
    peak_pss = 0
    peak_rows: list[tuple[int, str, int, int | None]] = []
    missing_pss = set()

    await session.start()
    sc_task = asyncio.create_task(
        run_agent.screencast(session, watch_event, stop_event, recorder)
    )
    try:
        await session.navigate_to(url)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            rows = sample(os.getpid())
            rss = sum(r[2] for r in rows)
            pss = sum(r[2] if r[3] is None else r[3] for r in rows)
            missing_pss.update(r[0] for r in rows if r[3] is None)
            if pss > peak_pss:
                peak_pss, peak_rows = pss, rows
            peak_rss = max(peak_rss, rss)
            print(
                f"  t+{seconds - (deadline - time.monotonic()):5.1f}s  "
                f"rss {rss / MB:6.0f} MB   pss {pss / MB:6.0f} MB   "
                f"{len(rows)} procs",
                flush=True,
            )
            await asyncio.sleep(interval)
    finally:
        stop_event.set()
        try:
            await asyncio.wait_for(sc_task, timeout=5)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        if recorder:
            await asyncio.to_thread(recorder.stop)
        await session.kill()

    label = "recording on" if record else "QA_RECORD=0"
    print(f"\n{label}: peak tree RSS {peak_rss / MB:.0f} MB, "
          f"peak PSS {peak_pss / MB:.0f} MB, {len(peak_rows)} procs")
    if peak_rss:
        print(f"RSS overstates PSS by {peak_rss / peak_pss:.2f}x")
    if missing_pss:
        print(f"no smaps_rollup for {len(missing_pss)} pid(s) — RSS substituted")
    print("\nAt the PSS peak:")
    for pid, name, rss, pss in sorted(peak_rows, key=lambda r: -(r[2] if r[3] is None else r[3])):
        shown = "n/a" if pss is None else f"{pss / MB:5.0f}"
        print(f"  {pid:>7}  {shown:>5} MB pss  {rss / MB:5.0f} MB rss  {name}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default="https://try.discourse.org")
    ap.add_argument("--seconds", type=float, default=45.0)
    ap.add_argument("--interval", type=float, default=3.0, help="matches MEM_POLL_MS")
    ap.add_argument("--no-record", dest="record", action="store_false")
    args = ap.parse_args()
    asyncio.run(probe(args.url, args.seconds, args.interval, args.record))


if __name__ == "__main__":
    main()
