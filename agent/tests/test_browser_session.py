"""US-043 — assertion-first spec, agent side: THE MECHANISM IS ACTUALLY ARMED.

The server's half is asserted in session-blob.test.js and
session-containment.test.js: the blob is encrypted at rest, it reaches a file,
and that file is gone afterwards. None of that is worth anything if the file
never reaches Chromium — and the way it fails to is not an exception anybody
would see.

THE FINDING THIS FILE EXISTS FOR. `BrowserProfile.storage_state` is typed
`str | Path | dict`, so handing it the parsed dict is the obvious thing to
write and reads as the cleaner one — no temp file, no cleanup. In this version
of browser-use it silently does nothing:

  * the `load_storage_state_from_file` validator that would have accepted a path
    is commented out (browser/profile.py:519-529), and
  * StorageStateWatchdog._load_storage_state gates on
    `os.path.exists(str(load_path))` (watchdogs/storage_state_watchdog.py:236) —
    a dict stringifies to `{'cookies': [...]}`, which is not a path, so it
    returns early and loads nothing at all.

No error, no warning, no failed run. The browser opens cold, the agent walks
into the login page, and the run fails exactly the way an EXPIRED session fails
— which is the other thing this story is supposed to be able to tell you apart.
US-042 named this shape: a mechanism that is configured, believed, and absent.

So the assertions below are on the shape of what we hand the profile, not on
whether a session "was configured". The same reasoning as US-042's
test_navigation_policy.py, which asserts on the list-versus-set distinction
browser-use's fast path turns on rather than on the fence being "enabled".

Stdlib only, no browser-use import, like every other agent unit test.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import browser_session  # noqa: E402


class ProfileKwargs(unittest.TestCase):
    """What reaches BrowserProfile(**kwargs)."""

    def test_storage_state_is_a_path_string_never_a_dict(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write(json.dumps({"cookies": [], "origins": []}))
            path = f.name
        try:
            kwargs = browser_session.profile_kwargs({"QA_STORAGE_STATE": path})
            self.assertIsInstance(
                kwargs["storage_state"],
                str,
                "a dict is accepted by the type hint and loads nothing at runtime",
            )
            self.assertEqual(kwargs["storage_state"], path)
        finally:
            os.unlink(path)

    def test_no_session_means_the_key_is_absent_not_none(self):
        # `storage_state=None` is browser-use's own default and means the same
        # thing, but passing it also switches on StorageStateWatchdog's sibling
        # branch on user_data_dir. Not mentioning the field is the one spelling
        # that changes nothing about a run with no session.
        self.assertEqual(browser_session.profile_kwargs({}), {})
        self.assertEqual(browser_session.profile_kwargs({"QA_STORAGE_STATE": ""}), {})

    def test_a_path_that_does_not_exist_is_not_passed(self):
        # Fails CLOSED in the fixtures.py direction, not the navigation_policy
        # one: an unusable session must leave the run unauthenticated, which is
        # a flow that does not work. Passing a missing path would make
        # browser-use's watchdog WRITE that path on its first auto-save, quietly
        # turning our teardown target into a file nobody is tracking.
        kwargs = browser_session.profile_kwargs({"QA_STORAGE_STATE": "/nope/does/not/exist.json"})
        self.assertEqual(kwargs, {})

    def test_user_data_dir_is_pinned_off_when_a_session_is_used(self):
        # browser-use warns that the two conflict and that storage_state
        # "forcibly overwrites" (browser/profile.py:770-780). Ours are ephemeral
        # containers with no profile to keep, so this is only ever a footgun.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("{}")
            path = f.name
        try:
            kwargs = browser_session.profile_kwargs({"QA_STORAGE_STATE": path})
            self.assertIn("user_data_dir", kwargs)
            self.assertIsNone(kwargs["user_data_dir"])
        finally:
            os.unlink(path)


class Preamble(unittest.TestCase):
    """The deterministic actions run before the first LLM step (AC #5)."""

    def test_the_preamble_leads_with_the_navigation_to_start_url(self):
        # browser-use only auto-navigates when NO initial_actions are given
        # (agent/service.py:459) — it extracts the URL from the task and makes
        # it the first initial action itself. Supplying our own therefore takes
        # that over, and a preamble that forgot to navigate would run its
        # Escape keypress against about:blank and hand the LLM a blank tab.
        actions = browser_session.initial_actions(
            {"QA_INITIAL_ACTIONS": json.dumps([{"send_keys": {"keys": "Escape"}}])},
            "https://example.test/app",
        )
        self.assertEqual(actions[0], {"navigate": {"url": "https://example.test/app", "new_tab": False}})
        self.assertEqual(actions[1], {"send_keys": {"keys": "Escape"}})

    def test_no_preamble_yields_no_initial_actions_at_all(self):
        # Not `[{navigate: ...}]`. With none of our own, browser-use's own
        # extraction is left to do exactly what it does today — a project with
        # no preamble must be byte-for-byte the pre-US-043 run.
        for env in ({}, {"QA_INITIAL_ACTIONS": ""}, {"QA_INITIAL_ACTIONS": "[]"}):
            self.assertIsNone(browser_session.initial_actions(env, "https://example.test/"))

    def test_an_unreadable_preamble_is_no_preamble(self):
        # The fixtures.py direction again, and the opposite of
        # navigation_policy's. "No preamble" is the normal state of every
        # project, so resolving to it is safe; refusing to start would take out
        # every run in a project over one bad row.
        for raw in ("not json", '{"send_keys": {}}', '"escape"', "null", "42"):
            self.assertIsNone(
                browser_session.initial_actions({"QA_INITIAL_ACTIONS": raw}, "https://example.test/")
            )

    def test_only_the_four_deterministic_actions_survive(self):
        # The server validates at write time (session-blob.test.js, D6). This is
        # the second gate, on a value that may have been written by an older
        # version — and `read_file`/`upload_file` in particular are US-048's
        # boundary, which a project setting must not be able to reach.
        raw = json.dumps([
            {"send_keys": {"keys": "Escape"}},
            {"click": {"index": 3}},
            {"read_file": {"file_name": "/etc/passwd"}},
            {"upload_file": {"index": 1, "path": "/etc/passwd"}},
            {"wait": {"seconds": 2}},
        ])
        actions = browser_session.initial_actions({"QA_INITIAL_ACTIONS": raw}, "https://example.test/")
        names = [next(iter(a)) for a in actions]
        self.assertEqual(names, ["navigate", "send_keys", "wait"])


class CapturedState(unittest.TestCase):
    """What a login run stores — cookies AND localStorage.

    browser-use's PUBLIC `export_storage_state` hardcodes `'origins': []`
    (browser/session.py:1456, "Could add localStorage/sessionStorage extraction
    if needed"), so capturing through it drops localStorage entirely. An app
    that keeps its token there then gets a session that LOOKS captured — cookies
    counted, timestamp fresh, source "from a login run" — and authenticates
    nobody, which is the same believed-and-absent shape as the dict above. The
    private `_cdp_get_storage_state` is what StorageStateWatchdog itself uses and
    returns both, so run_agent calls that and narrows the result here.
    """

    def test_localStorage_survives_the_narrowing(self):
        raw = {
            "cookies": [{"name": "sid", "value": "abc", "domain": ".x.test", "path": "/"}],
            "origins": [
                {"origin": "https://x.test", "localStorage": [{"name": "jwt", "value": "eyJ"}]}
            ],
        }
        got = browser_session.to_storage_state(raw)
        self.assertEqual(got["origins"], raw["origins"], "localStorage must reach the stored blob")
        self.assertEqual(got["cookies"][0]["name"], "sid")

    def test_raw_cdp_cookie_extras_are_dropped(self):
        # Raw CDP cookies carry size/session/priority/sourceScheme. Nothing on
        # the load path wants them and they would ride into the encrypted column
        # forever.
        raw = {
            "cookies": [
                {
                    "name": "sid", "value": "abc", "domain": ".x.test", "path": "/",
                    "size": 42, "session": True, "priority": "Medium", "sourceScheme": "Secure",
                }
            ],
            "origins": [],
        }
        cookie = browser_session.to_storage_state(raw)["cookies"][0]
        self.assertEqual(
            sorted(cookie),
            sorted(["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite"]),
        )

    def test_a_missing_sameSite_becomes_the_browsers_own_default(self):
        # Chromium omits the field for cookies set without the attribute; the
        # loader expects the key, and Lax is what the browser applies anyway.
        raw = {"cookies": [{"name": "sid", "value": "a", "domain": "x.test", "path": "/"}]}
        self.assertEqual(browser_session.to_storage_state(raw)["cookies"][0]["sameSite"], "Lax")

    def test_junk_never_becomes_a_stored_session(self):
        for raw in (None, [], "cookies", {"cookies": "sid=abc"}, {"cookies": [None, {}]}):
            got = browser_session.to_storage_state(raw)
            self.assertEqual(got["cookies"], [])
            self.assertEqual(got["origins"], [])


class ExpiryCheck(unittest.TestCase):
    """AC #4 — a dead session says so, rather than failing the goal."""

    def test_the_verify_config_round_trips(self):
        env = {"QA_SESSION_VERIFY": json.dumps({"url_contains": "/dashboard", "text": "Sign out"})}
        check = browser_session.verify_config(env)
        self.assertEqual(check["url_contains"], "/dashboard")
        self.assertEqual(check["text"], "Sign out")

    def test_no_verify_config_means_no_check(self):
        # A session with nothing to assert on is legitimate — a pasted blob for
        # an SSO app may have no stable landing URL. The run then behaves as it
        # does today, which is the pre-US-043 behaviour and not a regression.
        for env in ({}, {"QA_SESSION_VERIFY": ""}, {"QA_SESSION_VERIFY": "{}"}, {"QA_SESSION_VERIFY": "junk"}):
            self.assertIsNone(browser_session.verify_config(env))

    def test_a_landing_url_that_matches_is_signed_in(self):
        check = {"url_contains": "/dashboard", "text": None}
        self.assertIsNone(browser_session.expiry_reason(check, "https://example.test/dashboard", ""))

    def test_a_landing_url_that_does_not_match_is_an_expired_session(self):
        check = {"url_contains": "/dashboard", "text": None}
        reason = browser_session.expiry_reason(check, "https://example.test/login?next=/dashboard", "")
        self.assertIsNotNone(reason)
        # The message is what a human reads on the report at 9am. It has to name
        # the session, not the goal — "could not find the checkout button" for a
        # cookie that expired overnight is the exact failure US-043 exists to
        # stop.
        self.assertIn("session", reason.lower())

    def test_a_query_string_mention_does_not_count_as_arriving(self):
        # `/login?next=/dashboard` contains "/dashboard" and is the single most
        # common shape of a login redirect. A naive substring test over the whole
        # URL therefore reports a dead session as live, and every run in the
        # project goes back to failing for the wrong reason — the bug this
        # feature was built to remove, reintroduced by the check meant to
        # detect it.
        check = {"url_contains": "/dashboard", "text": None}
        self.assertIsNotNone(
            browser_session.expiry_reason(check, "https://example.test/login?next=/dashboard", "")
        )
        self.assertIsNotNone(
            browser_session.expiry_reason(check, "https://example.test/login#/dashboard", "")
        )

    def test_an_identifying_text_is_honoured_when_there_is_no_stable_url(self):
        check = {"url_contains": None, "text": "Sign out"}
        self.assertIsNone(browser_session.expiry_reason(check, "https://example.test/", "… Sign out …"))
        self.assertIsNotNone(
            browser_session.expiry_reason(check, "https://example.test/", "Sign in to continue")
        )

    def test_both_configured_means_both_must_hold(self):
        # An app that redirects to the right URL and then renders a login modal
        # over it is not a signed-in session. `and`, not `or`.
        check = {"url_contains": "/app", "text": "Sign out"}
        self.assertIsNone(browser_session.expiry_reason(check, "https://example.test/app", "Sign out"))
        self.assertIsNotNone(
            browser_session.expiry_reason(check, "https://example.test/app", "Sign in")
        )

    def test_a_page_we_could_not_read_is_not_reported_as_expired(self):
        # `None` page text means the read failed, not that the text is absent.
        # Reporting expiry off a failed read would put `session_expired` on runs
        # whose session was fine, and the reason stops meaning anything the
        # moment it is ever wrong.
        check = {"url_contains": None, "text": "Sign out"}
        self.assertIsNone(browser_session.expiry_reason(check, "https://example.test/", None))


if __name__ == "__main__":
    unittest.main()
