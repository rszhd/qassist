"""Unit tests for measure_memory's /proc parsers (US-024).

This is a probe, not shipped behaviour — but it is the *instrument* the server's
`MAX_RUN_MEMORY_MB` gets baselined from, so a unit slip here is written into
`config.js` and two doc files and nothing later contradicts it. The first
re-baseline had a hand measurement to check against; the next one will not.

Same unit trap as `server/test/proc-memory.test.js`: smaps reports kB, `stat`
reports pages. Pure stdlib against a fake /proc — no browser, no real process.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import measure_memory  # noqa: E402


def write_proc(root, pid, ppid=1, rss_pages=0, pss_kb=None, comm="chrome"):
    d = os.path.join(str(root), str(pid))
    os.makedirs(d, exist_ok=True)
    # stat: pid (comm) state ppid ... rss at field 24 = index 21 after the ')'.
    after = ["S", str(ppid)] + ["0"] * 19 + [str(rss_pages), "0"]
    with open(os.path.join(d, "stat"), "w") as f:
        f.write(f"{pid} ({comm}) {' '.join(after)}\n")
    if pss_kb is not None:
        with open(os.path.join(d, "smaps_rollup"), "w") as f:
            f.write(f"Rss:  {rss_pages * 4} kB\nPss:  {pss_kb} kB\nShared_Clean: 0 kB\n")
    return d


def test_pss_is_read_as_kilobytes(tmp_path):
    # `Pss: 1024 kB` is one mebibyte. Read as bytes the probe reports a browser
    # costing 1 kB; read as pages, 4 MB — and either is a plausible-looking
    # table that gets copied into a story file as the new baseline.
    write_proc(tmp_path, 100, pss_kb=1024)
    assert measure_memory.pss_bytes(100, str(tmp_path)) == 1024 * 1024


def test_stat_rss_is_read_as_pages(tmp_path):
    write_proc(tmp_path, 100, rss_pages=256)
    assert measure_memory.stat_rss_bytes(100, str(tmp_path)) == 256 * measure_memory.PAGE_SIZE


def test_pss_and_rss_are_read_from_the_same_pid_independently(tmp_path):
    # The ratio between the two is the whole point of the probe, so they must
    # not be able to contaminate each other.
    write_proc(tmp_path, 100, rss_pages=500, pss_kb=100)
    assert measure_memory.pss_bytes(100, str(tmp_path)) == 100 * 1024
    assert measure_memory.stat_rss_bytes(100, str(tmp_path)) == 500 * measure_memory.PAGE_SIZE


def test_missing_smaps_rollup_is_none_not_zero(tmp_path):
    # None is substituted with RSS and counted in the "RSS substituted" line.
    # Zero would silently shrink the peak and under-size the limit.
    write_proc(tmp_path, 100, rss_pages=256, pss_kb=None)
    assert measure_memory.pss_bytes(100, str(tmp_path)) is None


def test_a_pss_line_in_an_unexpected_unit_is_refused(tmp_path):
    write_proc(tmp_path, 100, rss_pages=256)
    with open(os.path.join(str(tmp_path), "100", "smaps_rollup"), "w") as f:
        f.write("Pss: 4096 MB\n")
    assert measure_memory.pss_bytes(100, str(tmp_path)) is None


def test_a_comm_containing_spaces_and_parens_does_not_shift_the_fields(tmp_path):
    # Chromium helper names are tame, but the parse must key off the LAST ')'
    # or every field after it is read one column across.
    write_proc(tmp_path, 100, ppid=7, rss_pages=256, comm="we ird) name")
    assert measure_memory.stat_rss_bytes(100, str(tmp_path)) == 256 * measure_memory.PAGE_SIZE
    assert measure_memory._ppid(100, str(tmp_path)) == 7


def test_a_pid_that_is_gone_reads_as_none(tmp_path):
    assert measure_memory.stat_rss_bytes(999, str(tmp_path)) is None
    assert measure_memory.pss_bytes(999, str(tmp_path)) is None
    assert measure_memory._ppid(999, str(tmp_path)) is None
