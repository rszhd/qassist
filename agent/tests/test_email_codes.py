"""Unit tests for email_codes.py — the mailbox parsing that reads a
confirmation code or link out of a real signup email (US-013 tier 1).

This is the first agent-side test layer. The module is all pure stdlib, so the
suite runs with no browser, no IMAP server and no network: it drives the
extraction/formatting logic directly with hand-written subjects and bodies.
The IMAP fetch itself (ImapMailbox._fetch_newest and below) is I/O and is not
covered here — see backlog US-034.
"""
import email_codes as ec


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

    def test_standalone_digits_in_body_without_keyword(self):
        assert ec.extract_code("Hello", "Your reference is 5567 for records") == "5567"

    def test_no_code_returns_none(self):
        assert ec.extract_code("Newsletter", "Welcome to our site, enjoy") is None

    def test_too_long_a_run_is_not_a_code(self):
        # Standalone matcher caps at 8 digits, so an order number isn't a code.
        assert ec.extract_code("Order", "Order 1234567890 shipped") is None


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
