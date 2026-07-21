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
import email.utils
import html as html_lib
import imaplib
import re
import time
from dataclasses import dataclass
from email.message import Message

# Codes near a keyword ("your verification code is 123456", "PIN: 9482").
# The token must contain a digit so filler words ("is below") never match;
# length is checked in extract_code.
_CODE_NEAR_KEYWORD = re.compile(
    r"(?:code|otp|pin|passcode|password)\b.{0,20}?\b([A-Z0-9-]*\d[A-Z0-9-]*)\b",
    re.IGNORECASE | re.DOTALL,
)
# Subject style: "482913 is your ... code".
_CODE_LEADING = re.compile(r"^\W*(\d{4,8})\b")
_CODE_STANDALONE = re.compile(r"\b(\d{4,8})\b")
_HREF = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
_URL = re.compile(r"https?://[^\s<>\"')\]]+")
_CONFIRM_URL_HINT = re.compile(
    r"confirm|verif|activat|validate|register|signup|sign-up|token=|welcome", re.IGNORECASE
)


@dataclass
class Confirmation:
    subject: str
    sender: str
    code: str | None
    link: str | None


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


def extract_code(subject: str, body_text: str) -> str | None:
    """Best-effort verification-code extraction; keyword-adjacent wins."""
    for text in (subject, body_text):
        for m in _CODE_NEAR_KEYWORD.finditer(text):
            token = m.group(1)
            if 4 <= len(token) <= 10:
                return token
    m = _CODE_LEADING.search(subject)
    if m:
        return m.group(1)
    m = _CODE_STANDALONE.search(body_text)
    return m.group(1) if m else None


def extract_link(body_text: str, body_html: str) -> str | None:
    """First URL that looks like a confirmation/verification link."""
    candidates = [html_lib.unescape(u) for u in _HREF.findall(body_html)]
    candidates += _URL.findall(body_text)
    for url in candidates:
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
        self, to_address: str, since: float, timeout: float, poll_interval: float = 5.0
    ) -> Confirmation | None:
        """Poll the inbox until a message addressed to to_address arrives.

        Blocking (imaplib) — call via asyncio.to_thread. Reconnects per poll so
        a long wait can't die on a stale connection.
        """
        deadline = time.monotonic() + timeout
        while True:
            found = self._fetch_newest(to_address, since)
            if found is not None:
                return found
            if time.monotonic() >= deadline:
                return None
            time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))

    def _fetch_newest(self, to_address: str, since: float) -> Confirmation | None:
        conn = imaplib.IMAP4_SSL(self.host, self.port)
        try:
            conn.login(self.user, self.password)
            for folder in self.folders:
                found = self._search_folder(conn, folder, to_address, since)
                if found is not None:
                    return found
            return None
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    def _search_folder(
        self, conn: imaplib.IMAP4_SSL, folder: str, to_address: str, since: float
    ) -> Confirmation | None:
        try:
            status, _ = conn.select(f'"{folder}"', readonly=True)
        except Exception:
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
            plain, html = _walk_bodies(msg)
            body_text = plain or _strip_html(html)
            subject = str(email.header.make_header(email.header.decode_header(msg.get("Subject", ""))))
            return Confirmation(
                subject=subject,
                sender=msg.get("From", ""),
                code=extract_code(subject, body_text),
                link=extract_link(body_text, html),
            )
        return None
