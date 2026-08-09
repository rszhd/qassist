"""Unit tests for email_codes.py — the mailbox parsing that reads a
confirmation code or link out of a real signup email (US-013 tier 1).

This is the first agent-side test layer. The module is all pure stdlib, so the
suite runs with no browser, no IMAP server and no network: it drives the
extraction/formatting logic directly with hand-written subjects and bodies.
`_search_folder` takes its connection as an argument, so the message-selection
rules are driven through a stub connection here; `_fetch_newest`'s connection
reuse is driven by substituting the IMAP4_SSL constructor, so the socket itself
is still never opened.
"""
import email.utils
import imaplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import pytest

import email_codes as ec


def _raw_message(to, subject, body, sent, message_id="<a@test>"):
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = email.utils.format_datetime(sent)
    if message_id:
        msg["Message-ID"] = message_id
    msg.set_content(body)
    return msg.as_bytes()


class FakeConn:
    """Enough of imaplib.IMAP4_SSL for _search_folder: select/search/fetch.

    `messages` is oldest-first, mirroring the ascending sequence numbers a real
    IMAP SEARCH returns — the ordering _search_folder reverses to read newest
    first.
    """

    def __init__(self, messages, select_status="OK"):
        self.messages = list(messages)
        self.select_status = select_status

    def select(self, folder, readonly=False):
        return self.select_status, [b""]

    def search(self, charset, *criteria):
        ids = [str(i + 1).encode() for i in range(len(self.messages))]
        return "OK", [b" ".join(ids)]

    def fetch(self, msg_id, spec):
        raw = self.messages[int(msg_id) - 1]
        return "OK", [(b"1 (RFC822 {%d}" % len(raw), raw), b")"]


NOW = datetime(2026, 8, 9, 11, 46, tzinfo=timezone.utc)
ADDRESS = "qa-deff8050a9@arang.space"


def _search(messages, since=None, exclude_ids=None, code_length=None):
    conn = FakeConn(messages)
    return ec.ImapMailbox(
        host="h", port=993, user="qa@test", password="pw", domain=None,
    )._search_folder(
        conn, "INBOX", ADDRESS,
        (NOW - timedelta(minutes=1)).timestamp() if since is None else since,
        exclude_ids=exclude_ids,
        code_length=code_length,
    )


class TestExtractCode:
    def test_keyword_adjacent_wins(self):
        assert ec.extract_code("", "Your verification code is 123456.") == "123456"

    def test_pin_with_punctuation(self):
        assert ec.extract_code("", "PIN: 9482 — do not share") == "9482"

    def test_filler_after_keyword_is_skipped_for_the_real_token(self):
        # "below" has no digit, so the keyword match keeps scanning to the code.
        assert ec.extract_code("", "Your code is below\n\n482913") == "482913"

    def test_alphanumeric_token(self):
        assert ec.extract_code("", "Your code is A1B2C3 today") == "A1B2C3"

    def test_leading_digits_in_subject(self):
        # Token precedes the keyword, so the subject-leading rule supplies it.
        assert ec.extract_code("482913 is your login code", "") == "482913"

    def test_standalone_digits_need_a_keyword_somewhere(self):
        # The subject supplies the keyword; the body supplies only the token.
        assert ec.extract_code("Your OTP Code", "482913") == "482913"

    def test_bare_number_in_a_keyword_free_email_is_not_a_code(self):
        # Behaviour change with BUG-012: this used to return 5567. An email
        # that never says code/otp/pin/passcode/password has nothing to
        # extract — a digit run in it is a reference, a postcode, a street.
        assert ec.extract_code("Hello", "Your reference is 5567 for records") is None

    def test_no_code_returns_none(self):
        assert ec.extract_code("Newsletter", "Welcome to our site, enjoy") is None

    def test_too_long_a_run_is_not_a_code(self):
        # Standalone matcher caps at 8 digits, so an order number isn't a code.
        assert ec.extract_code("Order code", "Order 1234567890 shipped") is None


class TestExtractCodeStagingEmails:
    """BUG-012 — cut from the two real emails of staging run cf7a4e1e
    (2026-08-09). The site sends a link-only email and an OTP email, and both
    carry a postal footer whose postcode is a plausible 5-digit "code".
    """

    LINK_BODY = (
        "Thank you for signing up. In order to activate your account, we need "
        "to verify that you own this email address.\n"
        "Please verify your email address by clicking the verification link below.\n"
        "Verify my account\n"
        "Thank You!\n"
        "CIDB E-Construct Services Sdn Bhd,\n"
        "Tingkat 11, Menara Sunway Putra,\n"
        "Jalan Putra, 50350 KUALA LUMPUR\n"
        "Phone: +603- 4040 0399"
    )
    OTP_BODY = (
        "To activate your account, please enter this One-Time Password (OTP) "
        "on the activation page:\n"
        "053604\n"
        "This code will expire in 10 minutes.\n"
        "Thank You!\n"
        "CIDB E-Construct Services Sdn Bhd,\n"
        "Jalan Putra, 50350 KUALA LUMPUR\n"
        "Phone: +603- 4040 0399"
    )

    def test_link_only_email_yields_no_code(self):
        # The staging failure: this returned "50350" — the postcode — and the
        # agent typed it into a six-box OTP field.
        assert ec.extract_code("Email Verification", self.LINK_BODY) is None

    def test_otp_email_code_found_without_a_stated_width(self):
        assert ec.extract_code("Your OTP Code", self.OTP_BODY) == "053604"

    def test_otp_email_code_found_by_the_keyword_path_not_by_position(self):
        # "…(OTP) on the activation page: 053604" puts 26 characters between
        # keyword and code. The keyword window must span that, so selection
        # does not depend on the code preceding the footer in the body — here
        # the footer comes first, and the bare fallback would answer 50350.
        body = (
            "Jalan Putra, 50350 KUALA LUMPUR\n"
            "Enter this One-Time Password (OTP) on the activation page:\n053604"
        )
        assert ec.extract_code("", body) == "053604"

    def test_otp_email_with_a_stated_width(self):
        assert ec.extract_code("Your OTP Code", self.OTP_BODY, code_length=6) == "053604"

    def test_link_is_still_extracted_from_the_link_email(self):
        html = (
            '<a href="https://smartv2-sp.econstruct.com.my/register/'
            'account-activation/fnbvaiyvixDF"><button>Verify my account</button></a>'
        )
        link = ec.extract_link("", html)
        assert link is not None and link.endswith("/fnbvaiyvixDF")


class TestExtractCodeLength:
    """`code_length` is the field width the page asks for, when the agent can
    see it. The staging run of 2026-08-09 is the case: a 5-character token was
    returned for a six-box OTP field, five boxes filled, and the site answered
    "invalid OTP" — a parse failure wearing the costume of a site bug.
    """

    def test_short_token_is_rejected_rather_than_returned(self):
        assert ec.extract_code("", "Your code is 50350 today", code_length=6) is None

    def test_matching_token_wins_over_a_nearer_wrong_length(self):
        body = "Your code expires in 30 minutes. Verification code: 782721"
        assert ec.extract_code("", body, code_length=6) == "782721"

    def test_length_is_not_checked_when_unset(self):
        assert ec.extract_code("", "Your code is 50350 today") == "50350"

    def test_alphanumeric_code_of_the_right_length_still_matches(self):
        assert ec.extract_code("", "Your code is A1B2C3 today", code_length=6) == "A1B2C3"


class TestSearchFolderSelection:
    def test_newest_message_wins(self):
        messages = [
            _raw_message(ADDRESS, "Older", "Your code is 111111", NOW, "<old@test>"),
            _raw_message(ADDRESS, "Newer", "Your code is 222222", NOW + timedelta(seconds=30), "<new@test>"),
        ]
        assert _search(messages).code == "222222"

    def test_consumed_message_is_skipped_for_the_one_behind_it(self):
        messages = [
            _raw_message(ADDRESS, "Older", "Your code is 111111", NOW, "<old@test>"),
            _raw_message(ADDRESS, "Newer", "Your code is 222222", NOW + timedelta(seconds=30), "<new@test>"),
        ]
        assert _search(messages, exclude_ids={"<new@test>"}).code == "111111"

    def test_nothing_is_returned_once_every_match_is_consumed(self):
        # The watermark assertion. After a resend the site has invalidated the
        # code in the message we already used, so handing it back a second time
        # guarantees "invalid or expired" forever (staging, 2026-08-09).
        messages = [_raw_message(ADDRESS, "Only", "Your code is 111111", NOW, "<one@test>")]
        assert _search(messages, exclude_ids={"<one@test>"}) is None

    def test_message_id_is_reported_so_the_caller_can_record_it(self):
        messages = [_raw_message(ADDRESS, "Only", "Your code is 111111", NOW, "<one@test>")]
        assert _search(messages).message_id == "<one@test>"

    def test_message_without_an_id_gets_a_stable_synthetic_key(self):
        messages = [_raw_message(ADDRESS, "Only", "Your code is 111111", NOW, message_id=None)]
        first = _search(messages).message_id
        assert first
        assert _search(messages).message_id == first
        assert _search(messages, exclude_ids={first}) is None

    def test_message_older_than_since_is_ignored(self):
        messages = [_raw_message(ADDRESS, "Stale", "Your code is 111111", NOW - timedelta(hours=2), "<old@test>")]
        assert _search(messages, since=NOW.timestamp()) is None

    def test_message_to_another_address_is_ignored(self):
        messages = [_raw_message("someone-else@arang.space", "Other", "Your code is 111111", NOW, "<x@test>")]
        assert _search(messages) is None

    def test_code_length_is_applied_to_the_fetched_message(self):
        messages = [_raw_message(ADDRESS, "Only", "Your code is 50350", NOW, "<one@test>")]
        found = _search(messages, code_length=6)
        assert found is not None
        assert found.code is None


class TestExtractorSeam:
    """US-080 — `_search_folder` consults the wired extractor first.

    The extractor here is the stub the module's no-network rule requires; the
    real one (LLM + validation) lives in email_extract.py and is tested there.
    Contract: None = the call failed, regex answers; a tuple — including
    (None, None) — is final, because a regex answer behind a reader that read
    the email and found nothing is the confident wrong answer US-080 removes.
    """

    MESSAGES = [_raw_message(ADDRESS, "Your OTP Code", "Your code is 482913", NOW)]

    def _search_with(self, extractor, code_length=None):
        conn = FakeConn(self.MESSAGES)
        box = ec.ImapMailbox(host="h", port=993, user="qa@test", password="pw", domain=None)
        box.extractor = extractor
        return box._search_folder(
            conn, "INBOX", ADDRESS, (NOW - timedelta(minutes=1)).timestamp(),
            code_length=code_length,
        )

    def test_extractor_answer_wins_over_regex(self):
        found = self._search_with(lambda s, b, h, w: ("482913", "https://x.test/verify"))
        assert found.code == "482913"
        assert found.link == "https://x.test/verify"

    def test_extractor_nothing_found_is_final_and_regex_stays_silent(self):
        # Regex would answer 482913 here; the reader's (None, None) must stand.
        found = self._search_with(lambda s, b, h, w: (None, None))
        assert found is not None
        assert found.code is None
        assert found.link is None

    def test_failed_call_falls_back_to_regex(self):
        found = self._search_with(lambda s, b, h, w: None)
        assert found.code == "482913"

    def test_no_extractor_wired_is_the_regex_path(self):
        found = self._search_with(None)
        assert found.code == "482913"

    def test_extractor_receives_subject_body_and_stated_width(self):
        seen = {}

        def extractor(subject, body_text, body_html, code_length):
            seen.update(subject=subject, body=body_text, width=code_length)
            return (None, None)

        self._search_with(extractor, code_length=6)
        assert seen["subject"] == "Your OTP Code"
        assert "482913" in seen["body"]
        assert seen["width"] == 6

    def test_confirmation_carries_no_body_field(self):
        # The body reaches the extractor and nowhere else: every event the
        # action emits is built from Confirmation, so the payload cage is its
        # field list. A body field added here would be one emit away from the
        # feed, the logs and the report.
        assert set(ec.Confirmation.__dataclass_fields__) == {
            "subject", "sender", "code", "link", "message_id"
        }


class TestWaitForConfirmation:
    def _mailbox(self, results):
        box = ec.ImapMailbox(host="h", port=993, user="qa@test", password="pw", domain=None)
        self.calls = []

        def fake_fetch(to_address, since, exclude_ids=None, code_length=None):
            self.calls.append(exclude_ids)
            return results.pop(0) if results else None

        box._fetch_newest = fake_fetch
        return box

    def test_polls_until_a_new_message_appears(self):
        found = ec.Confirmation(subject="s", sender="f", code="222222", link=None, message_id="<new@test>")
        box = self._mailbox([None, None, found])
        got = box.wait_for_confirmation(ADDRESS, NOW.timestamp(), timeout=5, poll_interval=0)
        assert got is found
        assert len(self.calls) == 3

    def test_returns_none_when_the_deadline_passes(self):
        box = self._mailbox([])
        assert box.wait_for_confirmation(ADDRESS, NOW.timestamp(), timeout=0, poll_interval=0) is None

    def test_exclusions_reach_the_fetch(self):
        box = self._mailbox([])
        box.wait_for_confirmation(
            ADDRESS, NOW.timestamp(), timeout=0, poll_interval=0, exclude_ids={"<one@test>"}
        )
        assert self.calls == [{"<one@test>"}]


class TrackingConn(FakeConn):
    """FakeConn plus the login/logout calls _fetch_newest drives.

    `dies` makes every select raise the abort a server sends when it hangs up;
    `missing` makes it raise the plain error a server sends for a folder that
    does not exist. The two look alike from the call site and must not be
    treated alike.
    """

    def __init__(self, messages, dies=False, missing=()):
        super().__init__(messages)
        self.dies = dies
        self.missing = set(missing)
        self.selected = []
        self.logged_out = False

    def login(self, user, password):
        return "OK", [b"logged in"]

    def logout(self):
        self.logged_out = True
        return "BYE", [b""]

    def select(self, folder, readonly=False):
        self.selected.append(folder)
        if self.dies:
            raise imaplib.IMAP4.abort("socket error: EOF")
        if folder.strip('"') in self.missing:
            raise imaplib.IMAP4.error("SELECT command error: NO")
        return super().select(folder, readonly=readonly)


class TestConnectionReuse:
    """US-077 tier 1: one login per wait, not per poll."""

    def _mailbox(self, monkeypatch, *conns, folders=None):
        opened = []

        def fake_ssl(host, port):
            opened.append(conns[len(opened)])
            return opened[-1]

        monkeypatch.setattr(imaplib, "IMAP4_SSL", fake_ssl)
        box = ec.ImapMailbox(
            host="h", port=993, user="qa@test", password="pw", domain=None, folders=folders
        )
        return box, opened

    def _poll(self, box):
        return box._fetch_newest(ADDRESS, (NOW - timedelta(minutes=1)).timestamp())

    def test_repeated_polls_share_one_login(self, monkeypatch):
        conn = TrackingConn([])
        box, opened = self._mailbox(monkeypatch, conn)
        for _ in range(3):
            self._poll(box)
        assert len(opened) == 1
        assert len(conn.selected) == 3

    def test_a_dropped_connection_is_reopened_and_the_poll_still_answers(self, monkeypatch):
        raw = _raw_message(ADDRESS, "Confirm", "Your code is 482913", NOW)
        dead, live = TrackingConn([], dies=True), TrackingConn([raw])
        box, opened = self._mailbox(monkeypatch, dead, live)
        found = self._poll(box)
        assert found is not None and found.code == "482913"
        assert len(opened) == 2
        assert dead.logged_out

    def test_a_connection_that_dies_twice_raises_rather_than_looping(self, monkeypatch):
        box, opened = self._mailbox(
            monkeypatch, TrackingConn([], dies=True), TrackingConn([], dies=True)
        )
        with pytest.raises(imaplib.IMAP4.abort):
            self._poll(box)
        assert len(opened) == 2

    def test_a_missing_folder_is_skipped_without_reconnecting(self, monkeypatch):
        raw = _raw_message(ADDRESS, "Confirm", "Your code is 482913", NOW)
        conn = TrackingConn([raw], missing={"INBOX"})
        box, opened = self._mailbox(monkeypatch, conn, folders=["INBOX", "Bulk"])
        found = self._poll(box)
        assert found is not None and found.code == "482913"
        assert len(opened) == 1

    def test_close_ends_the_session_and_a_later_wait_starts_a_new_one(self, monkeypatch):
        first, second = TrackingConn([]), TrackingConn([])
        box, opened = self._mailbox(monkeypatch, first, second)
        self._poll(box)
        box.close()
        assert first.logged_out
        self._poll(box)
        assert len(opened) == 2

    def test_close_is_a_no_op_when_nothing_was_opened(self, monkeypatch):
        box, opened = self._mailbox(monkeypatch, TrackingConn([]))
        box.close()
        box.close()
        assert opened == []


class TestMaskCodes:
    """The subject is the only email text that reaches the LLM, and `scrub`
    only knows the token that was extracted — so a refused one must still be
    blanked before it can be read off the feed and guessed.
    """

    def test_subject_that_is_the_code(self):
        assert ec.mask_codes("482913 is your login code") == "<redacted:code> is your login code"

    def test_refused_wrong_length_token_is_still_masked(self):
        assert "50350" not in ec.mask_codes("Your code 50350 for SMART")

    def test_ordinary_subject_is_untouched(self):
        assert ec.mask_codes("Welcome to SMART") == "Welcome to SMART"

    def test_short_number_is_not_code_shaped(self):
        assert ec.mask_codes("Top 10 tips") == "Top 10 tips"


class TestExtractLink:
    def test_confirm_href_from_html(self):
        html = '<a href="https://x.test/verify?token=abc">Confirm</a>'
        assert ec.extract_link("", html) == "https://x.test/verify?token=abc"

    def test_trailing_punctuation_is_stripped(self):
        text = "Please activate at https://x.test/activate/1."
        assert ec.extract_link(text, "") == "https://x.test/activate/1"

    def test_html_entities_in_href_are_unescaped(self):
        html = '<a href="https://x.test/confirm?a=1&amp;b=2">go</a>'
        assert ec.extract_link("", html) == "https://x.test/confirm?a=1&b=2"

    def test_non_confirmation_link_is_ignored(self):
        assert ec.extract_link("Visit https://example.test/home for more", "") is None


class TestLabelledLinks:
    """What the LLM reader is shown (US-080 follow-up, staging run 6984279c).

    `link_candidates` is the set a returned link is validated against, so it
    is also the set the reader must be shown — anything outside it is refused
    anyway, and anything inside it that stays hidden is a link the reader
    cannot return. The label is the anchor text, because a list of bare URLs
    makes a confirmation link and an unsubscribe link indistinguishable.
    """

    def test_anchor_text_is_paired_with_its_href(self):
        html = '<a href="https://x.test/verify?token=abc">Verify my account</a>'
        assert ec.labelled_links("", html) == [
            ("Verify my account", "https://x.test/verify?token=abc")
        ]

    def test_markup_inside_the_anchor_becomes_flat_label_text(self):
        html = '<a href="https://x.test/v"><button>  Verify\n  my account </button></a>'
        assert ec.labelled_links("", html) == [("Verify my account", "https://x.test/v")]

    def test_a_bare_text_url_has_no_label(self):
        assert ec.labelled_links("Go to https://x.test/a now", "") == [("", "https://x.test/a")]

    def test_html_entities_are_unescaped_in_the_url(self):
        html = '<a href="https://x.test/c?a=1&amp;b=2">go</a>'
        assert ec.labelled_links("", html) == [("go", "https://x.test/c?a=1&b=2")]

    def test_every_labelled_url_is_a_candidate(self):
        # The two lists must not drift: validation reads one, the prompt the
        # other, and a URL in only one of them is either unreachable or
        # unrefusable.
        text = "Mirror: https://x.test/plain"
        html = '<a href="https://x.test/verify">Verify</a><a href="https://x.test/stop">Unsubscribe</a>'
        candidates = ec.link_candidates(text, html)
        assert [url for _, url in ec.labelled_links(text, html)] == candidates

    def test_a_url_present_as_both_href_and_text_is_listed_once(self):
        url = "https://x.test/verify?token=abc"
        pairs = ec.labelled_links(f"Or paste {url}", f'<a href="{url}">Verify</a>')
        assert pairs == [("Verify", url)]

    def test_no_links_is_an_empty_list(self):
        assert ec.labelled_links("Your code is 482913", "") == []


class TestStripHtml:
    def test_tags_removed_and_text_kept(self):
        out = ec._strip_html("<p>Hello <b>world</b></p>")
        assert "Hello" in out and "world" in out
        assert "<" not in out and ">" not in out

    def test_script_contents_dropped(self):
        out = ec._strip_html("<script>steal()</script>Visible")
        assert "Visible" in out
        assert "steal" not in out


class TestGenerateAddress:
    def _mailbox(self, domain):
        return ec.ImapMailbox(
            host="imap.gmail.com", port=993,
            user="qa.inbox@gmail.com", password="pw", domain=domain,
        )

    def test_plus_addressing_when_no_catch_all(self):
        assert self._mailbox(None).generate_address("42") == "qa.inbox+qa-42@gmail.com"

    def test_catch_all_domain_when_set(self):
        assert self._mailbox("qa.example.test").generate_address("42") == "qa-42@qa.example.test"


class TestFromEnv:
    def test_none_without_credentials(self):
        assert ec.ImapMailbox.from_env({}) is None

    def test_none_when_password_missing(self):
        assert ec.ImapMailbox.from_env({"QA_IMAP_USER": "qa@gmail.com"}) is None

    def test_defaults(self):
        box = ec.ImapMailbox.from_env({"QA_IMAP_USER": "qa@gmail.com", "QA_IMAP_PASSWORD": "pw"})
        assert box is not None
        assert box.host == "imap.gmail.com"
        assert box.port == 993
        assert box.folders == ["INBOX"]
        assert box.domain is None

    def test_folder_list_is_split_and_trimmed(self):
        box = ec.ImapMailbox.from_env({
            "QA_IMAP_USER": "qa@gmail.com",
            "QA_IMAP_PASSWORD": "pw",
            "QA_IMAP_FOLDERS": "INBOX, [Gmail]/Spam ",
            "QA_MAILBOX_DOMAIN": "qa.example.test",
        })
        assert box is not None
        assert box.folders == ["INBOX", "[Gmail]/Spam"]
        assert box.domain == "qa.example.test"
