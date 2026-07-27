"""US-044 AC #6: the report of a run against a broken page names what broke.

The acceptance criterion is deliberately fixture-based rather than live — "a
report whose diagnostics section names the failing request, proven against a
fixture, not a real site". `fixtures/broken_page_report_data.json` is what the
server writes for a run against `fixtures/broken-page.html` (every failure on
that page is one a screenshot cannot show), and this asserts the report built
from it actually says so.

Asserted on `build_html` rather than on the rendered PDF: the HTML is where the
content decisions live, and Chromium only turns it into pages. That keeps this
hermetic and instant — no browser launch, no network. Rendering it to a real PDF
is the hand-verification step, and `make_report.py <this fixture> out.pdf` is the
whole command.

Unlike the rest of the suite this module imports make_report, which pulls in
Playwright. That is a declared agent dependency and importing it launches
nothing; see pytest.ini.
"""
import json
import os

import make_report

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def build():
    path = os.path.join(FIXTURES, "broken_page_report_data.json")
    with open(path) as f:
        return make_report.build_html(json.load(f), FIXTURES)


class TestDiagnosticsSection:
    def test_the_failing_request_is_named_with_its_status(self):
        # The whole point of the story: the report says what broke, not that
        # something did.
        html = build()
        assert "/api/order" in html
        assert "500" in html

    def test_the_request_that_never_resolved_is_named_with_its_reason(self):
        html = build()
        assert "this-host-does-not-resolve.invalid/beacon" in html
        assert "net::ERR_NAME_NOT_RESOLVED" in html
        assert "FAILED" in html, "a transport failure has no status to show"

    def test_the_uncaught_exception_is_named(self):
        html = build()
        assert "Cannot read properties of null" in html
        assert "UNCAUGHT" in html

    def test_the_console_error_is_named(self):
        assert "Order submission failed: order rejected" in build()

    def test_findings_are_grouped_under_the_step_they_happened_during(self):
        html = build()
        assert "Step 1" in html and "Step 2" in html
        # Attribution is the part that makes this readable: the 500 belongs to
        # the submit step, so it must appear after that step's heading and
        # before the next one's.
        step2 = html.index("Step 2")
        step3 = html.index("Step 3")
        assert step2 < html.index("/api/order") < step3

    def test_a_repeated_finding_shows_its_count(self):
        assert "4×" in build()

    def test_what_the_cap_refused_is_disclosed(self):
        # A report that quietly truncated its evidence is worse than one that
        # says how much it left out.
        html = build()
        assert "12" in html
        assert "per-step capture limit" in html

    def test_the_section_is_titled_and_counted(self):
        html = build()
        assert "Browser diagnostics" in html
        assert "7 findings" in html


class TestQuietRun:
    def test_a_run_with_no_findings_grows_no_section(self):
        # The common case. An empty "Browser diagnostics" page on every passing
        # run would be a blank sheet in every emailed report.
        html = make_report.build_html({"goal": "g", "success": True, "steps": []}, FIXTURES)
        assert "Browser diagnostics" not in html

    def test_a_report_file_from_before_this_story_still_renders(self):
        # Every run already in an installation's runs/ predates both keys.
        html = make_report.build_html({"goal": "g", "steps": [], "diagnostics": None}, FIXTURES)
        assert "Browser diagnostics" not in html
        assert "QAssist" in html


class TestEscaping:
    def test_page_authored_text_cannot_inject_markup(self):
        # Every string in this section was written by the site under test. The
        # renderer sets it with set_content, so an unescaped `<script>` would run
        # inside our own PDF pipeline.
        data = {
            "goal": "g",
            "steps": [],
            "diagnostics": [
                {"kind": "console", "step": 1, "level": "error",
                 "text": "<script>alert(1)</script>", "count": 1},
                {"kind": "request", "step": 1, "status": 500,
                 "url": "https://x/?q=<img src=x onerror=alert(1)>", "count": 1},
            ],
        }
        html = make_report.build_html(data, FIXTURES)
        # The property is that no *tag* can form: the payload may well survive as
        # literal text, and inert text is the correct outcome. So the assertion is
        # on the delimiters, not on the words between them.
        assert "<script>" not in html
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
        assert "<img" not in html
        assert "&lt;img src=x onerror=alert(1)&gt;" in html
