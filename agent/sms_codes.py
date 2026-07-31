"""SMS access for a tested login's second factor (US-059 tier 2).

Twilio-backed: polls the REST Messages resource for the newest inbound message
to a provisioned test number and extracts its verification code, reusing
`email_codes.extract_code` for the digits rather than a second regex. Same
180s ceiling and reconnect-per-poll posture as the mailbox (tier 1) already
set — `wait_for_code` opens a fresh request each poll rather than holding one
open.

Twilio is BYO-credentials, consistent with BYOK everywhere else in QAssist: a
programmable number is a monthly line rental plus per-message cost, and many
target sites reject VoIP numbers outright. Both are documented limitations,
not bugs this module can route around.

Configuration (environment):
  QA_TWILIO_ACCOUNT_SID   Twilio Account SID                        (required)
  QA_TWILIO_AUTH_TOKEN    Twilio Auth Token                          (required)
  QA_TWILIO_TEST_NUMBER   the provisioned number the flow texts, E.164 (required)
"""
from __future__ import annotations

import base64
import email.utils
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from email_codes import extract_code

_API_BASE = "https://api.twilio.com/2010-04-01"


def _parse_twilio_date(value: str | None) -> float | None:
    """Twilio's date_sent/date_created are RFC 2822, same shape email already parses."""
    if not value:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return parsed.timestamp() if parsed is not None else None


def _pick_code(messages: list[dict], since: float) -> str | None:
    """First message (assumed newest-first, Twilio's default order) sent at or
    after `since` whose body yields a code. Pure — no I/O — so it is unit
    tested directly against hand-built message payloads.
    """
    for message in messages:
        sent = _parse_twilio_date(message.get("date_sent") or message.get("date_created"))
        if sent is None or sent < since:
            continue
        code = extract_code("", message.get("body") or "")
        if code:
            return code
    return None


@dataclass
class TwilioSmsInbox:
    account_sid: str
    auth_token: str
    test_number: str

    @classmethod
    def from_env(cls, env) -> "TwilioSmsInbox | None":
        sid = (env.get("QA_TWILIO_ACCOUNT_SID") or "").strip()
        token = (env.get("QA_TWILIO_AUTH_TOKEN") or "").strip()
        number = (env.get("QA_TWILIO_TEST_NUMBER") or "").strip()
        if not sid or not token or not number:
            return None
        return cls(account_sid=sid, auth_token=token, test_number=number)

    def wait_for_code(self, since: float, timeout: float, poll_interval: float = 5.0) -> str | None:
        """Poll for the newest SMS to test_number sent no earlier than `since`.

        Blocking (urllib) — call via asyncio.to_thread. Reconnects per poll,
        same posture as ImapMailbox.wait_for_confirmation.
        """
        deadline = time.monotonic() + timeout
        while True:
            code = self._fetch_newest_code(since)
            if code is not None:
                return code
            if time.monotonic() >= deadline:
                return None
            time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))

    def _fetch_newest_code(self, since: float) -> str | None:
        query = urllib.parse.urlencode({"To": self.test_number, "PageSize": 20})
        url = f"{_API_BASE}/Accounts/{self.account_sid}/Messages.json?{query}"
        req = urllib.request.Request(url)
        credentials = base64.b64encode(f"{self.account_sid}:{self.auth_token}".encode()).decode()
        req.add_header("Authorization", f"Basic {credentials}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        return _pick_code(data.get("messages", []), since)
