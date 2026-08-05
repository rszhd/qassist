"""Unit tests for navigation_policy — the agent's end of the fence (US-042).

The server decides a run's policy and hands it to the child as three env vars;
this module turns them into the three `BrowserProfile` fields browser-use's
SecurityWatchdog enforces, and maps a blocked-navigation event to the
`failure_reason` a run reports. Pure stdlib — no browser, IMAP or network —
like secret_vars and email_codes.

Correctness-critical (navigation-confinement row in
backlog/correctness-critical.md). The subtle failure this file exists to catch
is not a wrong answer, it is a *silent* one: `profile_kwargs` returning `{}`,
or returning `block_ip_addresses=False`, produces an agent that runs perfectly
and is not fenced at all. Nothing downstream notices — the run passes, the
report renders, and the operator believes an allowlist is in force. So the
assertions here are mostly about what must be PRESENT, and the parsing is
deliberately fail-CLOSED: unlike secret_vars, which fails to `{}` because a
broken secret must not half-apply, a broken policy env resolves to the strictest
reading, because a fence that fails open is worth less than no fence.

The redirect case in US-042's AC #2 is not testable here and is not pretended
at: it needs a live Chromium and a real 302, and it is `SecurityWatchdog`'s
`on_NavigationCompleteEvent` that catches it. What these tests pin is that the
flags which arm that watchdog are actually built and passed.
"""
import navigation_policy as np


class TestBlockIpAddresses:
    def test_default_is_on_when_unset(self):
        # An agent spawned by anything that forgot the variable must still be
        # fenced. This is the fail-closed rule at its most load-bearing.
        assert np.profile_kwargs({})["block_ip_addresses"] is True

    def test_explicit_off(self):
        assert np.profile_kwargs({"QA_BLOCK_PRIVATE_NETWORKS": "0"})["block_ip_addresses"] is False

    def test_only_the_documented_off_values_turn_it_off(self):
        for off in ("0", "false", "no", "off", "FALSE", " 0 "):
            assert np.profile_kwargs({"QA_BLOCK_PRIVATE_NETWORKS": off})["block_ip_addresses"] is False
        # Anything else is on — including garbage, an empty string, and the
        # spellings a hurried operator might reach for.
        for on in ("1", "true", "yes", "", "maybe", "TRUE", "off!"):
            assert np.profile_kwargs({"QA_BLOCK_PRIVATE_NETWORKS": on})["block_ip_addresses"] is True


class TestDeniedHosts:
    def test_absent_is_empty(self):
        assert np.profile_kwargs({})["prohibited_domains"] == []

    def test_comma_separated(self):
        kwargs = np.profile_kwargs({"QA_DENIED_HOSTS": "localhost,db,metadata.google.internal"})
        assert kwargs["prohibited_domains"] == ["localhost", "db", "metadata.google.internal"]

    def test_whitespace_and_blanks_dropped(self):
        kwargs = np.profile_kwargs({"QA_DENIED_HOSTS": " localhost , , db ,"})
        assert kwargs["prohibited_domains"] == ["localhost", "db"]

    def test_stays_a_list_not_a_set(self):
        # browser-use takes a fast O(1) path for a `set` that does EXACT
        # hostname matching only, and a slow path for a `list` that honours
        # glob patterns (security_watchdog.py `_is_url_match`). Handing it a set
        # would silently stop `*.internal` from matching anything.
        kwargs = np.profile_kwargs({"QA_DENIED_HOSTS": "*.internal"})
        assert isinstance(kwargs["prohibited_domains"], list)


class TestAllowedDomains:
    def test_absent_is_none_not_empty_list(self):
        # The distinction matters to browser-use: `allowed_domains=[]` is falsy
        # and behaves as "no allowlist", but None is what the field's own
        # default is, and passing the library its own default is the honest
        # spelling of "this project set nothing".
        assert np.profile_kwargs({})["allowed_domains"] is None

    def test_empty_json_array_is_none(self):
        assert np.profile_kwargs({"QA_ALLOWED_DOMAINS": "[]"})["allowed_domains"] is None

    def test_json_array_parsed(self):
        kwargs = np.profile_kwargs({"QA_ALLOWED_DOMAINS": '["*.staging.example.com"]'})
        assert kwargs["allowed_domains"] == ["*.staging.example.com"]

    def test_malformed_json_raises_rather_than_resolving_to_no_allowlist(self):
        # The inverse of secret_vars' rule, and deliberately so. A corrupted
        # allowlist must NOT resolve to "no allowlist" — that is the one bug
        # that turns a confined project into an open one while everything looks
        # healthy.
        #
        # Note it cannot fail closed by returning `[]` either, which was the
        # first thing this assertion tried: browser-use treats an EMPTY
        # allowed_domains as falsy and skips the allowlist branch entirely
        # (security_watchdog.py `_is_url_allowed`), so `[]` means "allow
        # everything", not "allow nothing". There is no in-band value for
        # "confine to nothing", so the only honest failure is a loud one — the
        # agent refuses to start and the run reports an error.
        for bad in ("{not json", '"a string"', "{}", "[1, 2]", "[null]"):
            try:
                np.profile_kwargs({"QA_ALLOWED_DOMAINS": bad})
            except ValueError:
                continue
            raise AssertionError(f"{bad!r} produced a profile instead of refusing")

    def test_non_string_entries_dropped_when_usable_ones_remain(self):
        kwargs = np.profile_kwargs({"QA_ALLOWED_DOMAINS": '["example.com", 5, ""]'})
        assert kwargs["allowed_domains"] == ["example.com"]


class TestProfileKwargsShape:
    def test_all_three_fields_are_always_present(self):
        # The silent failure this whole file guards: a kwargs dict missing a key
        # leaves BrowserProfile on its own default, and browser-use's default
        # for block_ip_addresses is False. An agent with no fence and no error.
        kwargs = np.profile_kwargs({})
        assert set(kwargs) == {"allowed_domains", "prohibited_domains", "block_ip_addresses"}


class TestFailureReason:
    def test_blocked_navigation_maps_to_a_reason(self):
        # SecurityWatchdog raises ValueError("Navigation to <url> blocked by
        # security policy") out of on_NavigateToUrlEvent, which reaches us as an
        # agent failure string. AC #3: that must land as a failure_reason, not
        # as a generic crash.
        failure = "ValueError: Navigation to http://169.254.169.254/ blocked by security policy"
        assert np.failure_reason_for(failure) == "navigation_blocked"

    def test_blocked_url_is_recovered_from_the_message(self):
        failure = "ValueError: Navigation to http://169.254.169.254/ blocked by security policy"
        assert np.blocked_url_in(failure) == "http://169.254.169.254/"

    def test_an_ordinary_failure_has_no_reason(self):
        # The half that keeps the field meaningful: everything else stays null,
        # so a non-null failure_reason always means the fence fired.
        for other in (
            "TimeoutError: page load timed out",
            "RuntimeError: the model refused",
            "",
            None,
        ):
            assert np.failure_reason_for(other) is None
            assert np.blocked_url_in(other) is None

    def test_a_failure_that_merely_mentions_the_words_is_not_a_block(self):
        # A goal like "check the page blocked by security policy renders" must
        # not manufacture a fence event out of the agent's own prose.
        assert np.failure_reason_for("AssertionError: expected 'blocked by security policy'") is None


def refusal(url):
    return f"ValueError: Navigation to {url} blocked by security policy"


class TestNewBlocks:
    """The scan-dedup half of run_agent.py's `report_blocks`.

    SecurityWatchdog refuses inside the navigate action, so the evidence lands
    in browser-use's error history and stays there. The whole history is
    re-scanned at every step boundary and once more after the run, which is what
    makes the `reported` set load-bearing rather than an optimisation.
    """

    def test_a_refusal_is_found_and_recorded(self):
        reported = set()
        assert np.new_blocks([[refusal("http://169.254.169.254/")]], reported) == [
            "http://169.254.169.254/"
        ]
        assert reported == {"http://169.254.169.254/"}

    def test_the_same_refusal_is_announced_once_across_scans(self):
        # The failure this guards is noise that hides the signal. A fenced
        # navigation the agent keeps retrying stays in the history from the step
        # it happened onwards, so a scan without the set emits a `blocked` event
        # per step per refusal — and the operator who needs to see that the
        # allowlist fired sees a wall instead.
        reported = set()
        history = [[refusal("http://10.0.0.5/")]]
        assert np.new_blocks(history, reported) == ["http://10.0.0.5/"]
        history.append([refusal("http://10.0.0.5/")])
        assert np.new_blocks(history, reported) == []
        assert np.new_blocks(history, reported) == []

    def test_the_final_sweep_finds_what_no_step_reached(self):
        # A block on the last step, or one that took the run down, has no later
        # step callback to announce it. The sweep after the run reads the same
        # set, so it reports that one and repeats none of the earlier ones.
        reported = set()
        np.new_blocks([[refusal("http://10.0.0.5/")]], reported)
        late = [[refusal("http://10.0.0.5/")], [refusal("http://metadata.internal/")]]
        assert np.new_blocks(late, reported) == ["http://metadata.internal/"]

    def test_distinct_refusals_are_all_reported_in_order(self):
        reported = set()
        history = [
            [refusal("http://a.internal/")],
            [refusal("http://b.internal/"), refusal("http://c.internal/")],
        ]
        assert np.new_blocks(history, reported) == [
            "http://a.internal/", "http://b.internal/", "http://c.internal/"
        ]

    def test_a_bare_message_is_scanned_like_a_list(self):
        # browser-use's history holds a list per step, but an entry arrives as a
        # bare string often enough that treating it as an iterable of characters
        # would silently find nothing at all.
        reported = set()
        assert np.new_blocks([refusal("http://a.internal/")], reported) == ["http://a.internal/"]

    def test_empty_steps_and_ordinary_failures_yield_nothing(self):
        reported = set()
        history = [None, [], [None], ["TimeoutError: page load timed out"], "", [""]]
        assert np.new_blocks(history, reported) == []
        assert reported == set()

    def test_no_history_at_all_is_not_an_error(self):
        # `safe(agent.history.errors, [])` resolves to the default on a run that
        # crashed before browser-use had a history, and this is called from a
        # path that must never raise.
        for absent in (None, [], ()):
            assert np.new_blocks(absent, set()) == []

    def test_prose_quoting_the_phrase_is_not_a_refusal(self):
        # The same guard as `blocked_url_in`, asserted through the loop that
        # feeds the `blocked` event: an agent narrating a fenced page must not
        # manufacture one.
        reported = set()
        history = [["AssertionError: expected 'blocked by security policy'"]]
        assert np.new_blocks(history, reported) == []
