"""Assertion set for `diagnostics` — the agent's network/console evidence (US-044).

Written for review BEFORE the implementation, per CLAUDE.md's assertion-first
rule. Two of the listed failure classes meet in this one buffer, and both fail
*silently* — a leak looks like a report, and a swallowed diagnostic looks like a
clean page.

**Redaction.** Every byte in here is page-authored: request URLs carry query
strings, console lines carry whatever the app printed. It all lands in
`report_data.json` and in a PDF that US-012 emails. Three ways a US-035 secret
gets out, and only the first is obvious:

  * it is simply never scrubbed;
  * ORDER — truncating a long line before scrubbing it splits the secret, so
    `scrub` no longer matches the full value and the surviving prefix ships.
    A truncate-first implementation passes every "is the secret gone" test
    written against a *short* message;
  * the DEDUPE KEY — keying on raw text keeps the value in the buffer even when
    the emitted entry is clean, and makes two entries that differ only inside
    the secret look distinct, so the step's cap is spent on cardinality that
    exists only because of the secret.

**Volume control.** The cap is per KIND, per STEP, and the per-step budget must
RESET on each step. A cap that is really per-run lets a chatty single-page app
burn the whole budget on step 1 and record nothing for the step that failed —
the only step this story exists to explain. The inverse matters too: one kind
must not crowd out another, or five console warnings hide the 500. What the cap
refuses is *counted*; evidence may be dropped, never silently.

Pure stdlib — no browser-use, Playwright or CDP imports — so it runs in the
agent's ordinary pytest suite alongside redact and secret_vars.
"""
import json

import pytest

import diagnostics


SENS = {"api_token": "tok_liveAAAABBBBCCCCDDDD", "qa_password": "Qa1!hunter2xyz"}


def buf(sensitive=None, **kw):
    """A buffer already on step 1 — the common case, one line instead of two."""
    d = diagnostics.Diagnostics(sensitive=sensitive, **kw)
    d.set_step(1)
    return d


def texts(entries):
    return [e.get("text") or e.get("url") for e in entries]


# --------------------------------------------------------------------------
# What is even a diagnostic. The always-on artifact is small and curated: a
# 200 is not evidence, and neither is console.log.
# --------------------------------------------------------------------------
class TestWhatCounts:
    @pytest.mark.parametrize("status", [200, 201, 204, 301, 302, 304, 399])
    def test_successful_response_is_not_captured(self, status):
        d = buf()
        d.request("https://app.test/ok", status=status)
        assert d.drain() == []

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 422, 500, 502, 503])
    def test_failed_response_is_captured(self, status):
        d = buf()
        d.request("https://app.test/api", status=status)
        (entry,) = d.drain()
        assert entry["kind"] == "request"
        assert entry["status"] == status
        assert entry["url"] == "https://app.test/api"

    def test_transport_failure_with_no_status_is_captured(self):
        # A request that never came back has no status at all — the CORS
        # rejection and the DNS failure both arrive this way, and they are
        # exactly the failures a screenshot cannot show.
        d = buf()
        d.request("https://api.test/x", error="net::ERR_NAME_NOT_RESOLVED")
        (entry,) = d.drain()
        assert entry["status"] is None
        assert entry["error"] == "net::ERR_NAME_NOT_RESOLVED"

    @pytest.mark.parametrize("level", ["error", "warning", "warn"])
    def test_console_error_and_warning_are_captured(self, level):
        # CDP's Runtime.consoleAPICalled says "warning"; everyone writing the
        # calling code says "warn". Accept both, store one.
        d = buf()
        d.console(level, "boom")
        (entry,) = d.drain()
        assert entry["level"] == ("error" if level == "error" else "warning")

    @pytest.mark.parametrize("level", ["log", "info", "debug", "trace", "table", ""])
    def test_chatty_console_levels_are_ignored(self, level):
        d = buf()
        d.console(level, "just talking")
        assert d.drain() == []

    def test_uncaught_exception_is_captured(self):
        d = buf()
        d.exception("TypeError: Cannot read properties of null")
        (entry,) = d.drain()
        assert entry["kind"] == "exception"
        assert entry["text"] == "TypeError: Cannot read properties of null"


# --------------------------------------------------------------------------
# Redaction. The correctness-critical half.
# --------------------------------------------------------------------------
class TestRedaction:
    def test_secret_in_a_console_line_is_redacted(self):
        d = buf(SENS)
        d.console("error", "auth failed for Qa1!hunter2xyz")
        assert texts(d.drain()) == ["auth failed for <redacted:qa_password>"]

    def test_secret_in_a_request_query_string_is_redacted(self):
        d = buf(SENS)
        d.request("https://api.test/v1?token=tok_liveAAAABBBBCCCCDDDD", status=500)
        assert texts(d.drain()) == ["https://api.test/v1?token=<redacted:api_token>"]

    def test_secret_in_a_transport_error_string_is_redacted(self):
        d = buf(SENS)
        d.request("https://api.test/v1", error="refused while sending Qa1!hunter2xyz")
        (entry,) = d.drain()
        assert "hunter2" not in entry["error"]

    def test_scrub_runs_before_truncation(self):
        # THE order bug. A secret that straddles the truncation boundary must be
        # replaced whole, not cut into a shippable prefix. Truncate-first yields
        # "GET failed for tok_liveAAAA" — a live token prefix, in a PDF.
        d = buf(SENS, max_text=28)
        d.console("error", "GET failed for tok_liveAAAABBBBCCCCDDDD retrying")
        (entry,) = d.drain()
        assert "tok_live" not in entry["text"]
        assert len(entry["text"]) <= 28

    def test_truncation_still_happens(self):
        # The other half of the pair: proving the secret is gone is worthless if
        # the implementation simply stopped truncating.
        d = buf(max_text=40)
        d.console("error", "x" * 500)
        (entry,) = d.drain()
        assert len(entry["text"]) <= 40

    def test_dedupe_key_is_built_from_the_scrubbed_text(self):
        # Two lines identical except inside the secret are ONE diagnostic. Key on
        # the raw text and they are two — the step's budget is spent on
        # cardinality that only the secret created, and the raw value is what the
        # buffer is holding to tell them apart.
        d = buf({"code": "111111"})
        d.console("error", "bad code 111111")
        d.console("error", "bad code 111111")
        (entry,) = d.drain()
        assert entry["count"] == 2
        assert entry["text"] == "bad code <redacted:code>"

    def test_no_secret_value_survives_anywhere_in_the_drained_payload(self):
        # The canary, over the serialized form: `report_data.json` and the PDF
        # are built from exactly this, so a value hiding in a field nobody
        # thought to assert on is still a value that gets emailed.
        d = buf(SENS)
        d.console("error", "Qa1!hunter2xyz")
        d.console("warning", "token tok_liveAAAABBBBCCCCDDDD expired")
        d.exception("Error: Qa1!hunter2xyz is not a function")
        d.request("https://api.test/?t=tok_liveAAAABBBBCCCCDDDD", status=403)
        d.request("https://api.test/x", error="sent Qa1!hunter2xyz")
        blob = json.dumps(d.drain())
        for value in SENS.values():
            assert value not in blob

    def test_no_secrets_configured_leaves_text_alone(self):
        for sensitive in (None, {}):
            d = buf(sensitive)
            d.console("error", "Qa1!hunter2xyz")
            assert texts(d.drain()) == ["Qa1!hunter2xyz"]

    def test_empty_secret_value_redacts_nothing(self):
        # Mirrors test_redact's guard: an unset variable must not turn every
        # diagnostic into <redacted:...>, which would be a different way to lose
        # the evidence.
        d = buf({"email_code": ""})
        d.console("error", "unchanged")
        assert texts(d.drain()) == ["unchanged"]


# --------------------------------------------------------------------------
# Deduplication. `n× TypeError: …` rather than n rows.
# --------------------------------------------------------------------------
class TestDedupe:
    def test_identical_lines_collapse_with_a_count(self):
        d = buf()
        for _ in range(2000):
            d.console("error", "TypeError: x is not a function")
        (entry,) = d.drain()
        assert entry["count"] == 2000

    def test_the_status_is_part_of_the_key(self):
        # The same endpoint answering 500 and then 404 is two findings.
        d = buf()
        d.request("https://api.test/cart", status=500)
        d.request("https://api.test/cart", status=404)
        assert sorted(e["status"] for e in d.drain()) == [404, 500]

    def test_the_kind_is_part_of_the_key(self):
        d = buf()
        d.console("error", "same words")
        d.exception("same words")
        assert len(d.drain()) == 2

    def test_the_level_is_part_of_the_key(self):
        d = buf()
        d.console("error", "same words")
        d.console("warning", "same words")
        assert len(d.drain()) == 2

    def test_the_same_line_on_two_steps_is_two_entries(self):
        # Attribution outranks tidiness: an error on the step that failed is a
        # different fact from the same error on step 1, and collapsing them
        # would put the finding on the wrong step.
        d = buf()
        d.console("error", "same words")
        d.set_step(2)
        d.console("error", "same words")
        assert sorted(e["step"] for e in d.drain()) == [1, 2]


# --------------------------------------------------------------------------
# Volume control. The other correctness-critical half.
# --------------------------------------------------------------------------
class TestCaps:
    def test_distinct_entries_per_kind_per_step_are_capped(self):
        d = buf(max_per_kind_per_step=3)
        for i in range(50):
            d.console("error", f"distinct error {i}")
        assert len(d.drain()) == 3

    def test_the_per_step_budget_resets_on_the_next_step(self):
        # THE cap bug. A per-run cap dressed as a per-step one lets a chatty
        # step 1 exhaust the budget and record NOTHING for the step that failed.
        d = buf(max_per_kind_per_step=3)
        for i in range(50):
            d.console("error", f"noise {i}")
        d.set_step(2)
        d.console("error", "the 500 that explains the failure")
        step2 = [e for e in d.drain() if e["step"] == 2]
        assert texts(step2) == ["the 500 that explains the failure"]

    def test_each_kind_has_its_own_budget(self):
        # Five console warnings must not crowd out the failed request in the
        # same step; they are not competing for one list.
        d = buf(max_per_kind_per_step=2)
        d.console("warning", "chatter a")
        d.console("warning", "chatter b")
        d.console("warning", "chatter c")
        d.request("https://api.test/checkout", status=500)
        kinds = sorted(e["kind"] for e in d.drain())
        assert kinds == ["console", "console", "request"]

    def test_a_repeat_of_a_kept_entry_still_counts_past_the_cap(self):
        # At cap the buffer stops accepting NEW findings, not new occurrences of
        # one it already holds — that costs nothing and keeps `2000×` honest.
        d = buf(max_per_kind_per_step=1)
        d.console("error", "the one we kept")
        for i in range(10):
            d.console("error", f"turned away {i}")
        for _ in range(9):
            d.console("error", "the one we kept")
        (entry,) = d.drain()
        assert entry["count"] == 10

    def test_what_the_cap_refused_is_counted(self):
        # Evidence may be dropped; it may not be dropped silently. This is what
        # lets the report say "+143 more" instead of implying a quiet page.
        d = buf(max_per_kind_per_step=2)
        for i in range(12):
            d.console("error", f"distinct {i}")
        assert d.dropped == 10

    def test_dropped_accumulates_across_steps_and_never_decreases(self):
        d = buf(max_per_kind_per_step=1)
        for i in range(5):
            d.console("error", f"a{i}")
        after_step1 = d.dropped
        d.set_step(2)
        d.drain()
        for i in range(5):
            d.console("error", f"b{i}")
        assert after_step1 == 4
        assert d.dropped == 8

    def test_nothing_dropped_means_nothing_counted(self):
        d = buf(max_per_kind_per_step=5)
        d.console("error", "one")
        assert d.dropped == 0

    def test_the_defaults_bound_a_run_without_being_configured(self):
        # The pipe into Express is the one thing in this architecture that must
        # not back up, so the shipped default has to be small enough that
        # max_steps × kinds × cap stays a report and not an archive.
        assert 1 <= diagnostics.MAX_PER_KIND_PER_STEP <= 10
        assert 80 <= diagnostics.MAX_TEXT <= 500


# --------------------------------------------------------------------------
# Attribution and draining. Each finding names the step it happened during;
# each finding crosses stdout exactly once.
# --------------------------------------------------------------------------
class TestAttributionAndDrain:
    def test_an_entry_takes_the_step_current_when_it_was_captured(self):
        d = diagnostics.Diagnostics()
        d.set_step(1)
        d.console("error", "during one")
        d.set_step(7)
        d.console("error", "during seven")
        by_text = {e["text"]: e["step"] for e in d.drain()}
        assert by_text == {"during one": 1, "during seven": 7}

    def test_findings_before_the_first_step_have_no_step(self):
        # The page's own load errors arrive before any step callback. They are
        # evidence — the report just cannot hang them off a step number.
        d = diagnostics.Diagnostics()
        d.console("error", "failed to load /main.js")
        (entry,) = d.drain()
        assert entry["step"] is None

    def test_drain_empties_the_buffer(self):
        d = buf()
        d.console("error", "boom")
        assert len(d.drain()) == 1
        assert d.drain() == []

    def test_a_repeat_after_a_drain_is_a_fresh_entry(self):
        # Once a finding has crossed stdout its count is fixed; the same line
        # again is a new entry, not a retroactive edit to one Express already
        # relayed and a viewer already saw.
        d = buf()
        d.console("error", "boom")
        d.drain()
        d.console("error", "boom")
        (entry,) = d.drain()
        assert entry["count"] == 1

    def test_drain_on_an_untouched_buffer_is_empty(self):
        assert diagnostics.Diagnostics().drain() == []


# --------------------------------------------------------------------------
# A reporting bug must never cost a run. Same rule report_blocks() follows:
# this is a bystander on the hot path of every CDP event on the session.
# --------------------------------------------------------------------------
class TestNeverRaises:
    @pytest.mark.parametrize("junk", [None, 42, b"bytes", [], {}, object()])
    def test_junk_console_text_is_survivable(self, junk):
        d = buf(SENS)
        d.console("error", junk)
        d.drain()  # whatever it decided, it did not raise

    @pytest.mark.parametrize("junk", [None, "500", -1, 1.5, [], object()])
    def test_junk_status_is_survivable(self, junk):
        d = buf(SENS)
        d.request("https://api.test/x", status=junk)
        d.drain()

    @pytest.mark.parametrize("junk", [None, 42, b"bytes", [], object()])
    def test_junk_url_is_survivable(self, junk):
        d = buf(SENS)
        d.request(junk, status=500)
        d.drain()

    def test_junk_exception_text_is_survivable(self):
        d = buf(SENS)
        d.exception(None)
        d.drain()

    def test_a_bad_step_marker_is_survivable(self):
        d = diagnostics.Diagnostics()
        d.set_step("not a number")
        d.console("error", "boom")
        d.drain()


# --------------------------------------------------------------------------
# The two CDP formatters. Ordinary test-alongside cases, not part of the
# reviewed assertion set above: these only decide how readable a line is, and
# the redaction/cap guarantees apply to whatever they return.
# --------------------------------------------------------------------------
class TestConsoleText:
    def test_primitive_args_are_joined(self):
        args = [{"type": "string", "value": "count:"}, {"type": "number", "value": 42}]
        assert diagnostics.console_text(args) == "count: 42"

    def test_an_error_arg_uses_its_description(self):
        # The description carries the message and stack; `className` alone would
        # reduce the one line worth having to "TypeError".
        args = [{"type": "object", "className": "TypeError",
                 "description": "TypeError: x is not a function\n    at f (app.js:1)"}]
        assert diagnostics.console_text(args).startswith("TypeError: x is not a function")

    def test_an_opaque_arg_falls_back_to_its_class_then_its_type(self):
        assert diagnostics.console_text([{"type": "object", "className": "Response"}]) == "Response"
        assert diagnostics.console_text([{"type": "symbol"}]) == "<symbol>"

    def test_a_falsy_primitive_is_not_swallowed_by_the_description_branch(self):
        # `"value" in arg` rather than a truthiness test: console.error(0) and
        # console.error(false) are lines someone printed on purpose.
        assert diagnostics.console_text([{"type": "number", "value": 0}]) == "0"
        assert diagnostics.console_text([{"type": "boolean", "value": False}]) == "False"

    def test_junk_is_empty_not_an_exception(self):
        for junk in (None, [], [None], ["not a dict"], [{}]):
            assert diagnostics.console_text(junk) == ""


class TestPendingRequests:
    def test_a_started_request_can_be_named_when_it_fails(self):
        p = diagnostics.PendingRequests()
        p.started("req-1", "https://api.test/cart")
        assert p.finished("req-1") == "https://api.test/cart"

    def test_a_request_is_forgotten_once_handed_over(self):
        p = diagnostics.PendingRequests()
        p.started("req-1", "https://api.test/cart")
        p.finished("req-1")
        assert p.finished("req-1") is None

    def test_an_unknown_request_is_none_not_an_error(self):
        assert diagnostics.PendingRequests().finished("never-seen") is None

    def test_the_map_is_bounded_and_evicts_the_oldest(self):
        # On the hot path of every request a single-page app makes, so it has to
        # stay bounded — and the newest are the ones still in flight.
        p = diagnostics.PendingRequests(limit=3)
        for i in range(6):
            p.started(f"req-{i}", f"https://api.test/{i}")
        assert p.finished("req-0") is None
        assert p.finished("req-5") == "https://api.test/5"

    def test_a_redirect_reusing_its_id_keeps_the_latest_url(self):
        p = diagnostics.PendingRequests()
        p.started("req-1", "https://api.test/old")
        p.started("req-1", "https://api.test/new")
        assert p.finished("req-1") == "https://api.test/new"

    def test_blank_ids_and_urls_are_not_tracked(self):
        p = diagnostics.PendingRequests()
        p.started("", "https://api.test/x")
        p.started("req-1", None)
        assert p.finished("") is None
        assert p.finished("req-1") is None


class TestExceptionText:
    def test_the_exception_description_wins(self):
        details = {"text": "Uncaught", "exception": {"description": "TypeError: nope"}}
        assert diagnostics.exception_text(details) == "TypeError: nope"

    def test_a_thrown_non_error_uses_its_value(self):
        details = {"text": "Uncaught", "exception": {"type": "string", "value": "plain throw"}}
        assert diagnostics.exception_text(details) == "plain throw"

    def test_bare_text_is_the_fallback(self):
        assert diagnostics.exception_text({"text": "Uncaught SyntaxError"}) == "Uncaught SyntaxError"

    def test_junk_is_empty_not_an_exception(self):
        for junk in (None, "string", 42, {}, {"exception": None}):
            assert diagnostics.exception_text(junk) == ""
