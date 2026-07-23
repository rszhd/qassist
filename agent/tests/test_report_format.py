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
