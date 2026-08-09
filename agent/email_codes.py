"""Mailbox access for registration-flow tests (US-013 tier 1).

Gives a run a unique test email address and fetches the confirmation
code/link a site sends there. The generic IMAP provider covers Gmail today
(app password + plus-addressing: user+qa-<tag>@gmail.com) and a catch-all
domain later (set QA_MAILBOX_DOMAIN); other providers (Mailosaur) become
sibling classes selected via QA_MAILBOX_PROVIDER.

Configuration (environment):
  QA_IMAP_USER       mailbox login, e.g. qa.inbox@gmail.com  (required)
  QA_IMAP_PASSWORD   app password / IMAP password            (required)
  QA_IMAP_HOST       default imap.gmail.com
  QA_IMAP_PORT       default 993 (SSL)
  QA_IMAP_FOLDERS    comma-separated folders to search, default "INBOX".
                     Include the provider's spam folder so filtered forwards
                     are still found (Yahoo: "INBOX,Bulk"; Gmail:
                     "INBOX,[Gmail]/Spam")
  QA_MAILBOX_DOMAIN  optional catch-all domain; addresses become
                     qa-<tag>@<domain> instead of plus-addressing the user
"""
from __future__ import annotations

import email
import email.header
import email.utils
import hashlib
import html as html_lib
import imaplib
import re
import time
from dataclasses import dataclass
from email.message import Message

# Codes near a keyword ("your verification code is 123456", "PIN: 9482").
# The token must contain a digit so filler words ("is below") never match;
# length is checked in extract_code. The 40-character window spans a clause
# between keyword and code — "…Password (OTP) on the activation page: 053604"
# holds 26 (BUG-012).
_CODE_KEYWORD = re.compile(r"code|otp|pin|passcode|password", re.IGNORECASE)
_CODE_NEAR_KEYWORD = re.compile(
    r"(?:code|otp|pin|passcode|password)\b.{0,40}?\b([A-Z0-9-]*\d[A-Z0-9-]*)\b",
    re.IGNORECASE | re.DOTALL,
)
# Subject style: "482913 is your ... code".
_CODE_LEADING = re.compile(r"^\W*(\d{4,8})\b")
_CODE_STANDALONE = re.compile(r"\b(\d{4,8})\b")
_HREF = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
_ANCHOR = re.compile(
    r'<a\b[^>]*?href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL
)
_URL = re.compile(r"https?://[^\s<>\"')\]]+")
_CONFIRM_URL_HINT = re.compile(
    r"confirm|verif|activat|validate|register|signup|sign-up|token=|welcome", re.IGNORECASE
)
# Raised when the server hung up rather than answered: IMAP4.abort for a
# protocol-level teardown, OSError/EOFError for the socket under it.
_CONNECTION_LOST = (imaplib.IMAP4.abort, OSError, EOFError)


@dataclass
class Confirmation:
    subject: str
    sender: str
    code: str | None
    link: str | None
    message_id: str


def _walk_bodies(msg: Message) -> tuple[str, str]:
    """Return (plain_text, html) bodies, decoded best-effort."""
    plain, html = [], []
    for part in msg.walk():
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True)
            text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            continue
        (plain if ctype == "text/plain" else html).append(text)
    return "\n".join(plain), "\n".join(html)


def _strip_html(html: str) -> str:
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    return html_lib.unescape(text)


def _message_key(msg: Message) -> str:
    """Identity of a message, for "have I already used this one?".

    Message-ID when the sender set one, which is all but universal. The
    fallback digest can collide only for two messages sharing a sender, a
    subject and a send-second; that pair would cost one extra poll, where
    trusting a missing header would cost the stale code the caller is trying
    to avoid.
    """
    message_id = str(msg.get("Message-ID", "")).strip()
    if message_id:
        return message_id
    parts = "|".join(str(msg.get(h, "")) for h in ("Date", "From", "Subject"))
    return "digest:" + hashlib.sha256(parts.encode("utf-8", "replace")).hexdigest()[:32]


def _code_candidates(subject: str, body_text: str):
    """Code-shaped tokens, best first: keyword-adjacent, subject-leading, bare.

    The bare fallback runs only when the email mentions a code at all. A
    link-only email still holds digit runs — a footer's postcode, a street
    number, a phone — and one of those typed into an OTP field is BUG-012.
    """
    for text in (subject, body_text):
        for m in _CODE_NEAR_KEYWORD.finditer(text):
            yield m.group(1)
    m = _CODE_LEADING.search(subject)
    if m:
        yield m.group(1)
    if _CODE_KEYWORD.search(subject) or _CODE_KEYWORD.search(body_text):
        for m in _CODE_STANDALONE.finditer(body_text):
            yield m.group(1)


def extract_code(subject: str, body_text: str, code_length: int | None = None) -> str | None:
    """Best-effort verification-code extraction; keyword-adjacent wins.

    `code_length` is the width of the field the site is asking for, when the
    caller knows it. Proximity to the word "code" is a weak signal, so without
    it the first plausible token wins and a neighbouring number can beat the
    real code: a six-box OTP field once received a 5-character token, filled
    five boxes, and the site answered "invalid OTP" (staging, 2026-08-09).
    Given the width, a token of the wrong length is refused instead — the
    caller then reports that no code was found, which is a diagnosable
    outcome rather than a confident wrong one.
    """
    for token in _code_candidates(subject, body_text):
        if code_length:
            if len(token) == code_length:
                return token
        elif 4 <= len(token) <= 10:
            return token
    return None


_SUBJECT_CODE = re.compile(r"\b\d{4,10}\b")


def mask_codes(subject: str) -> str:
    """Blank code-shaped digit runs in a subject line.

    The subject is the only email text that reaches the LLM and the event feed,
    and it routinely *is* the code ("482913 is your login code"). `scrub` can
    only remove the value that was extracted, so a token extraction *refused* —
    for being the wrong length, say — would otherwise arrive intact and invite
    the guess the task prompt forbids.
    """
    return _SUBJECT_CODE.sub("<redacted:code>", subject)


def link_candidates(body_text: str, body_html: str) -> list[str]:
    """Every URL literally present in the email, hrefs first.

    Also the ground truth email_extract.py validates an LLM-returned link
    against: a link is only real if it is on this list.
    """
    candidates = [html_lib.unescape(u) for u in _HREF.findall(body_html)]
    candidates += _URL.findall(body_text)
    return candidates


def labelled_links(body_text: str, body_html: str) -> list[tuple[str, str]]:
    """The same URLs, each with the anchor text the recipient would click.

    This is what email_extract.py *shows* the reader, and link_candidates is
    what it validates the answer against — one list, so a URL can never be
    unreachable in the prompt yet acceptable in the cage, or the reverse.
    Duplicates are dropped: a URL given as both an href and a pasteable line
    is one choice, not two.

    The label carries the whole judgement. A confirmation link and an
    unsubscribe link are indistinguishable as bare URLs, and reading the
    email is the entire reason this reader exists.
    """
    labels: dict[str, str] = {}
    for href, inner in _ANCHOR.findall(body_html):
        url = html_lib.unescape(href)
        text = " ".join(_strip_html(inner).split())
        if text:
            labels.setdefault(url, text)
    seen: set[str] = set()
    pairs = []
    for url in link_candidates(body_text, body_html):
        if url not in seen:
            seen.add(url)
            pairs.append((labels.get(url, ""), url))
    return pairs


def extract_link(body_text: str, body_html: str) -> str | None:
    """First URL that looks like a confirmation/verification link."""
    for url in link_candidates(body_text, body_html):
        if _CONFIRM_URL_HINT.search(url):
            return url.rstrip(".,;")
    return None


class ImapMailbox:
    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        domain: str | None,
        folders: list[str] | None = None,
    ):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.domain = domain
        self.folders = folders or ["INBOX"]
        self._conn: imaplib.IMAP4_SSL | None = None
        # LLM-primary reader (US-080), wired by run_agent when the run has a
        # client: (subject, body_text, body_html, code_length) -> (code, link)
        # or None. See _extract for what the two answers mean.
        self.extractor = None

    @classmethod
    def from_env(cls, env) -> "ImapMailbox | None":
        user = (env.get("QA_IMAP_USER") or "").strip()
        password = (env.get("QA_IMAP_PASSWORD") or "").strip()
        if not user or not password:
            return None
        folders = [f.strip() for f in env.get("QA_IMAP_FOLDERS", "INBOX").split(",") if f.strip()]
        return cls(
            host=env.get("QA_IMAP_HOST", "imap.gmail.com"),
            port=int(env.get("QA_IMAP_PORT", "993")),
            user=user,
            password=password,
            domain=(env.get("QA_MAILBOX_DOMAIN") or "").strip() or None,
            folders=folders,
        )

    def generate_address(self, tag: str) -> str:
        if self.domain:
            return f"qa-{tag}@{self.domain}"
        local, _, host = self.user.partition("@")
        return f"{local}+qa-{tag}@{host}"

    def wait_for_confirmation(
        self,
        to_address: str,
        since: float,
        timeout: float,
        poll_interval: float = 5.0,
        exclude_ids: set[str] | None = None,
        code_length: int | None = None,
    ) -> Confirmation | None:
        """Poll the inbox until an unconsumed message to to_address arrives.

        `exclude_ids` holds the Message-IDs the caller has already acted on, and
        is what makes a second call wait for a genuinely new email instead of
        returning the previous one. `since` stays a fixed floor rather than
        advancing to the last message's Date, because Date is second-granular:
        a resend landing in the same second as the message it replaces is
        indistinguishable by timestamp, and Message-ID has no such boundary.

        Blocking (imaplib) — call via asyncio.to_thread. One login covers the
        whole wait and every wait after it until `close`: a login per 5s poll
        put four concurrent runs at ~50 logins a minute against one mailbox,
        which is a rate the provider throttles (US-077 tier 1). A dropped
        connection is still survivable — see `_fetch_newest`.
        """
        deadline = time.monotonic() + timeout
        while True:
            found = self._fetch_newest(to_address, since, exclude_ids, code_length)
            if found is not None:
                return found
            if time.monotonic() >= deadline:
                return None
            time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))

    def _connection(self) -> imaplib.IMAP4_SSL:
        if self._conn is None:
            conn = imaplib.IMAP4_SSL(self.host, self.port)
            conn.login(self.user, self.password)
            self._conn = conn
        return self._conn

    def close(self) -> None:
        """Log out and drop the held connection. Safe to call at any time."""
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.logout()
            except Exception:
                pass

    def _fetch_newest(
        self,
        to_address: str,
        since: float,
        exclude_ids: set[str] | None = None,
        code_length: int | None = None,
    ) -> Confirmation | None:
        """One poll over every configured folder, reconnecting once if needed.

        The connection outlives the poll now, so a wait long enough for the
        server to time it out finds it dead — reconnect on that rather than
        pre-emptively every poll, which is what made the login rate a problem.
        """
        try:
            return self._search_folders(
                self._connection(), to_address, since, exclude_ids, code_length
            )
        except _CONNECTION_LOST:
            self.close()
        return self._search_folders(
            self._connection(), to_address, since, exclude_ids, code_length
        )

    def _search_folders(
        self,
        conn: imaplib.IMAP4_SSL,
        to_address: str,
        since: float,
        exclude_ids: set[str] | None = None,
        code_length: int | None = None,
    ) -> Confirmation | None:
        for folder in self.folders:
            found = self._search_folder(conn, folder, to_address, since, exclude_ids, code_length)
            if found is not None:
                return found
        return None

    def _search_folder(
        self,
        conn: imaplib.IMAP4_SSL,
        folder: str,
        to_address: str,
        since: float,
        exclude_ids: set[str] | None = None,
        code_length: int | None = None,
    ) -> Confirmation | None:
        try:
            status, _ = conn.select(f'"{folder}"', readonly=True)
        except _CONNECTION_LOST:
            raise  # the connection died, not the folder — _fetch_newest reopens it
        except imaplib.IMAP4.error:
            return None  # folder doesn't exist on this provider
        if status != "OK":
            return None
        # IMAP SINCE is date-granular; filter to the exact timestamp below.
        since_date = time.strftime("%d-%b-%Y", time.gmtime(since - 86400))
        status, data = conn.search(None, "SINCE", since_date, "TO", to_address)
        if status != "OK" or not data or not data[0]:
            return None
        for msg_id in reversed(data[0].split()):
            status, parts = conn.fetch(msg_id, "(RFC822)")
            if status != "OK" or not parts or not isinstance(parts[0], tuple):
                continue
            msg = email.message_from_bytes(parts[0][1])
            sent = email.utils.parsedate_to_datetime(msg.get("Date", ""))
            if sent is not None and sent.timestamp() < since:
                continue
            recipients = " ".join(
                str(msg.get(h, "")) for h in ("To", "Cc", "Delivered-To", "X-Original-To")
            )
            if to_address.lower() not in recipients.lower():
                continue
            message_id = _message_key(msg)
            if exclude_ids and message_id in exclude_ids:
                continue
            plain, html = _walk_bodies(msg)
            body_text = plain or _strip_html(html)
            subject = str(email.header.make_header(email.header.decode_header(msg.get("Subject", ""))))
            code, link = self._extract(subject, body_text, html, code_length)
            return Confirmation(
                subject=subject,
                sender=msg.get("From", ""),
                code=code,
                link=link,
                message_id=message_id,
            )
        return None

    def _extract(
        self,
        subject: str,
        body_text: str,
        body_html: str,
        code_length: int | None,
    ) -> tuple[str | None, str | None]:
        """LLM-primary when an extractor is wired (US-080), regex otherwise.

        The extractor returns None only when its call failed; regex may then
        answer. A tuple — including (None, None) — is final: the regex failure
        mode is a *confident* wrong answer, so letting it speak behind a
        reader that read the email and found nothing would reintroduce
        BUG-012 exactly where the reader had just prevented it.
        """
        if self.extractor is not None:
            found = self.extractor(subject, body_text, body_html, code_length)
            if found is not None:
                return found
        return (
            extract_code(subject, body_text, code_length),
            extract_link(body_text, body_html),
        )
