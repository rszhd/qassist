"""TOTP (authenticator app) codes for a tested login's second factor (US-059 tier 1).

Given the shared secret a site showed at enrolment, produces the same 6-digit
code an authenticator app would show: an HMAC-SHA1 over the 30-second time
step (RFC 6238). Computed, not awaited — no polling loop, no vendor, no
account, and unlike an emailed code the secret itself does not expire, which
is what makes leaking it worse rather than better.

Configuration (environment):
  QA_TOTP_SECRET   the enrolment shared secret, base32 (as shown/exported by
                    the site), spaces and case ignored
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import time
from dataclasses import dataclass

_DIGITS = 6
_STEP = 30


@dataclass
class TotpSecret:
    key: bytes

    @classmethod
    def from_env(cls, env) -> "TotpSecret | None":
        raw = (env.get("QA_TOTP_SECRET") or "").strip()
        if not raw:
            return None
        normalized = raw.upper().replace(" ", "")
        padded = normalized + "=" * (-len(normalized) % 8)
        try:
            key = base64.b32decode(padded)
        except ValueError:
            return None
        if not key:
            return None
        return cls(key=key)

    def code(self, now: float | None = None) -> str:
        """RFC 6238 TOTP: HOTP over the 30s time step, SHA1, 6 digits."""
        counter = int((now if now is not None else time.time()) // _STEP)
        digest = hmac.new(self.key, struct.pack(">Q", counter), hashlib.sha1).digest()
        offset = digest[-1] & 0x0F
        value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
        return str(value % (10**_DIGITS)).zfill(_DIGITS)
