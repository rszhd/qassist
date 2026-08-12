"""US-046 tier 2: the report cover says what the run spent, or says it cannot.

The cover is the page a stakeholder reads and the only one that outlives the
app, so a cost printed there has to carry its own qualifier and must never
round or default its way into looking like a small charge. Asserted on
`build_html` for the same reason US-044's tests are: the HTML is where the
content decisions live, and Chromium only turns it into pages.

Same import rule as test_report_diagnostics.py — make_report defers Playwright
to main(), so build_html is reachable on stdlib alone.
"""
import json
import os

import make_report
import report_format as rf

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def cover(**over):
    data = {"goal": "g", "success": True, "steps": []}
    data.update(over)
    return make_report.build_html(data)


def priced(**over):
    usage = {
        "prompt_tokens": 38412,
        "completion_tokens": 2907,
        "total_tokens": 41319,
        "entry_count": 9,
        "total_cost": 0.0842,
        "cost_known": True,
        "by_model": [],
    }
    usage.update(over)
    return usage


class TestMoney:
    def test_cents_survive_a_figure_two_decimals_would_round_away(self):
        assert rf._money(0.0842) == "$0.084"

    def test_dollars_and_up_read_as_money(self):
        assert rf._money(1.5) == "$1.50"
        assert rf._money(12.345) == "$12.35"

    def test_below_a_tenth_of_a_cent_says_so_rather_than_printing_zero(self):
        # The failure the flag exists to prevent, reached by formatting: a real
        # charge shown as $0.00 is a plausible number nobody reports.
        assert rf._money(0.0004) == "< $0.001"

    def test_a_measured_zero_reads_as_free(self):
        assert rf._money(0) == "$0.00"

    def test_an_unusable_number_dashes(self):
        assert rf._money(None) == "—"
        assert rf._money("nonsense") == "—"
        assert rf._money(float("nan")) == "—"


class TestFmtCost:
    def test_a_known_cost_is_the_number(self):
        assert rf.fmt_cost(priced()) == "$0.084"

    def test_an_unpriced_run_is_unknown_whatever_number_came_with_it(self):
        # All three of the story's causes arrive here identically: the flag is
        # the discriminator, and the float beside it proves nothing.
        assert rf.fmt_cost(priced(cost_known=False, total_cost=None)) == "Unknown"
        assert rf.fmt_cost(priced(cost_known=False, total_cost=0.0)) == "Unknown"
        assert rf.fmt_cost(priced(cost_known=False, total_cost=0.0842)) == "Unknown"

    def test_an_unmeasured_run_dashes_rather_than_claiming_ignorance(self):
        assert rf.fmt_cost(None) == "—"
        assert rf.fmt_cost({}) == "—"

    def test_a_measured_zero_is_not_an_unknown(self):
        assert rf.fmt_cost(priced(total_cost=0.0)) == "$0.00"


class TestFmtTokens:
    def test_counts_are_grouped(self):
        assert rf.fmt_tokens(41319) == "41,319"

    def test_zero_renders_and_nothing_dashes(self):
        assert rf.fmt_tokens(0) == "0"
        assert rf.fmt_tokens(None) == "—"


class TestCoverBoxes:
    def test_a_priced_run_prints_the_estimate_under_a_label_that_qualifies_it(self):
        html = cover(usage=priced())
        assert "EST. COST" in html
        assert "$0.084" in html

    def test_an_unpriced_run_prints_unknown_and_keeps_its_tokens(self):
        html = cover(usage=priced(cost_known=False, total_cost=None))
        assert "Unknown" in html
        assert "41,319" in html
        # The whole point. A cover reading $0.00 over a run that cost real money
        # is the one wrong answer that looks right.
        assert "$0.00" not in html

    def test_the_prompt_completion_split_rides_with_the_total(self):
        html = cover(usage=priced())
        assert "38,412 in" in html
        assert "2,907 out" in html

    def test_a_run_nothing_measured_grows_no_boxes_at_all(self):
        # Every report rendered before this shipped, and every run whose agent
        # died before summarising itself. Two dashes on the cover would be worse
        # than the cover they replaced.
        html = cover()
        assert "EST. COST" not in html
        assert "TOKENS" not in html

    def test_a_run_that_called_no_model_still_reports_its_zero(self):
        # Distinct from "nothing measured": something counted, and counted none.
        html = cover(usage=priced(
            prompt_tokens=0, completion_tokens=0, total_tokens=0, total_cost=0.0
        ))
        assert "EST. COST" in html
        assert "$0.00" in html


class TestFixtures:
    """The two hand-render fixtures cover the two states, so a cover change can
    be looked at both ways without a real run."""

    def test_the_sample_is_the_priced_cover(self):
        with open(os.path.join(FIXTURES, "sample_report_data.json")) as f:
            html = make_report.build_html(json.load(f))
        assert "EST. COST" in html
        assert "$0.084" in html

    def test_the_broken_page_fixture_is_the_unpriced_cover(self):
        with open(os.path.join(FIXTURES, "broken_page_report_data.json")) as f:
            html = make_report.build_html(json.load(f))
        assert "EST. COST" in html
        assert "Unknown" in html
        assert "$0.00" not in html
