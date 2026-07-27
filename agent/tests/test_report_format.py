"""Unit tests for report_format.py — the pure PDF-report formatters (US-034).

Split out of make_report.py so they run without importing Playwright. All
stdlib, no I/O.
"""
import report_format as rf


class TestEsc:
    def test_html_metacharacters_escaped(self):
        assert rf.esc("<b> & \"x\"") == "&lt;b&gt; &amp; &quot;x&quot;"

    def test_none_is_empty_string(self):
        assert rf.esc(None) == ""

    def test_non_string_is_stringified(self):
        assert rf.esc(42) == "42"

    def test_zero_is_rendered_not_dropped(self):
        # 0 is not None, so it must render — the guard is `is not None`, not falsiness.
        assert rf.esc(0) == "0"


class TestFmtDuration:
    def test_none_and_zero_are_dash(self):
        assert rf.fmt_duration(None) == "—"
        assert rf.fmt_duration(0) == "—"

    def test_sub_minute_seconds(self):
        assert rf.fmt_duration(45) == "45s"

    def test_rounds_to_nearest_second(self):
        assert rf.fmt_duration(45.6) == "46s"

    def test_minutes_and_seconds(self):
        assert rf.fmt_duration(125) == "2m 5s"

    def test_exact_minute(self):
        assert rf.fmt_duration(60) == "1m 0s"

    def test_fifty_nine_point_five_rounds_up_across_the_minute_boundary(self):
        assert rf.fmt_duration(59.5) == "1m 0s"


class TestFmtElapsed:
    def test_none_is_dash_pair(self):
        assert rf.fmt_elapsed(None) == "—:—"

    def test_zero_is_zero_padded(self):
        assert rf.fmt_elapsed(0) == "00:00"

    def test_seconds_only(self):
        assert rf.fmt_elapsed(9) == "00:09"

    def test_minutes_and_seconds(self):
        assert rf.fmt_elapsed(125) == "02:05"

    def test_truncates_fractional_seconds(self):
        assert rf.fmt_elapsed(65.9) == "01:05"

    def test_beyond_an_hour_keeps_counting_minutes(self):
        assert rf.fmt_elapsed(3661) == "61:01"


class TestFmtDate:
    def test_z_suffix_is_utc(self):
        assert rf.fmt_date("2026-07-24T13:05:00Z") == "2026-07-24 · 13:05 UTC"

    def test_offset_is_converted_to_utc(self):
        assert rf.fmt_date("2026-07-24T15:05:00+02:00") == "2026-07-24 · 13:05 UTC"

    def test_unparseable_falls_back_to_escaped_input(self):
        assert rf.fmt_date("not a date") == "not a date"

    def test_unparseable_input_is_html_escaped(self):
        assert rf.fmt_date("<x>") == "&lt;x&gt;"


class TestStepOk:
    def test_empty_is_none(self):
        assert rf.step_ok("") is None
        assert rf.step_ok(None) is None

    def test_success_is_true(self):
        assert rf.step_ok("Successfully clicked the button") is True

    def test_failure_keywords_are_false(self):
        for text in ("Login failed", "hit an error", "blocked by captcha",
                     "unable to proceed", "could not find field"):
            assert rf.step_ok(text) is False, text

    def test_case_insensitive(self):
        assert rf.step_ok("FAILED") is False
        assert rf.step_ok("SUCCESS") is True

    def test_neutral_text_is_none(self):
        assert rf.step_ok("Navigated to the pricing page") is None

    def test_failure_wins_over_success_when_both_present(self):
        # Failure words are checked first, so a mixed line reads as failed.
        assert rf.step_ok("success was expected but the step failed") is False


class TestGroupDiagnostics:
    """US-044's flat evidence list, grouped for the report's step-keyed section."""

    def test_entries_group_by_step_in_step_order(self):
        diags = [
            {"kind": "console", "step": 3, "text": "late"},
            {"kind": "console", "step": 1, "text": "early"},
            {"kind": "request", "step": 3, "url": "/x"},
        ]
        grouped = rf.group_diagnostics(diags)
        assert [step for step, _ in grouped] == [1, 3]
        assert [e["text"] for e in grouped[1][1] if "text" in e] == ["late"]

    def test_findings_before_the_first_step_lead(self):
        # A page whose own assets failed broke before the agent did anything —
        # that reads first, not as a trailing footnote.
        diags = [{"kind": "console", "step": 2, "text": "b"}, {"kind": "console", "step": None, "text": "a"}]
        assert [step for step, _ in rf.group_diagnostics(diags)] == [None, 2]

    def test_order_within_a_step_is_capture_order(self):
        diags = [
            {"kind": "console", "step": 1, "text": "first"},
            {"kind": "console", "step": 1, "text": "second"},
        ]
        (_, entries), = rf.group_diagnostics(diags)
        assert [e["text"] for e in entries] == ["first", "second"]

    def test_empty_and_junk_are_empty(self):
        assert rf.group_diagnostics(None) == []
        assert rf.group_diagnostics([]) == []
        assert rf.group_diagnostics(["not a dict", None]) == []

    def test_an_unreadable_step_groups_with_the_stepless(self):
        assert [s for s, _ in rf.group_diagnostics([{"kind": "console", "step": "?"}])] == [None]


class TestDiagnosticLabel:
    def test_a_failed_request_reads_as_its_status(self):
        assert rf.diagnostic_label({"kind": "request", "status": 500}) == "500"

    def test_a_transport_failure_has_no_status_to_show(self):
        assert rf.diagnostic_label({"kind": "request", "status": None}) == "FAILED"

    def test_console_levels_split_error_from_warning(self):
        assert rf.diagnostic_label({"kind": "console", "level": "error"}) == "ERROR"
        assert rf.diagnostic_label({"kind": "console", "level": "warning"}) == "WARN"

    def test_an_exception_says_uncaught(self):
        assert rf.diagnostic_label({"kind": "exception"}) == "UNCAUGHT"

    def test_junk_is_a_dash_not_a_crash(self):
        assert rf.diagnostic_label(None) == "—"
        assert rf.diagnostic_label({}) == "—"


class TestDiagnosticDetail:
    def test_a_failed_request_shows_its_url(self):
        assert rf.diagnostic_detail({"kind": "request", "url": "https://a/b"}) == "https://a/b"

    def test_a_transport_failure_shows_the_url_and_the_reason(self):
        # Neither half is worth much alone: "the request that never came back"
        # is the URL plus why.
        detail = rf.diagnostic_detail(
            {"kind": "request", "url": "https://a/b", "error": "net::ERR_FAILED"}
        )
        assert detail == "https://a/b — net::ERR_FAILED"

    def test_console_and_exception_show_their_text(self):
        assert rf.diagnostic_detail({"kind": "console", "text": "boom"}) == "boom"
        assert rf.diagnostic_detail({"kind": "exception", "text": "died"}) == "died"

    def test_junk_is_empty_not_a_crash(self):
        assert rf.diagnostic_detail(None) == ""
        assert rf.diagnostic_detail({"kind": "request"}) == ""


class TestFmtOccurrences:
    def test_a_repeat_is_counted(self):
        assert rf.fmt_occurrences(7) == "7×"

    def test_a_single_occurrence_is_not_labelled(self):
        # "1×" on every row is noise; the count only earns its place when it
        # tells you something.
        assert rf.fmt_occurrences(1) == ""
        assert rf.fmt_occurrences(None) == ""
        assert rf.fmt_occurrences("many") == ""
