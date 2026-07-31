"""Unit tests for totp_codes.py — TOTP (authenticator app) codes (US-059 tier 1).

Correctness-critical (TOTP shared secret row in backlog/correctness-critical.md,
reviewed assertion-first): the code must match RFC 6238 to the letter, ingest
must fail closed on a bad secret rather than raise or silently mis-compute, and
the loaded secret and any code it produces must be redactable — a leak here is
a permanent second factor, not a ten-minute one, unlike an emailed code.

Pure stdlib, no I/O — like email_codes and secret_vars.
"""
import base64

from totp_codes import TotpSecret
import redact

# RFC 6238 Appendix B's own SHA1 test secret, ASCII "12345678901234567890".
_RFC_SECRET_B32 = base64.b32encode(b"12345678901234567890").decode()

# RFC 6238's published 8-digit SHA1 vectors, truncated to our 6 digits. Dynamic
# truncation takes value mod 10**digits, so mod 10**6 of the same 31-bit value
# is exactly the last 6 digits of the published 8-digit vector — not a
# recomputation, the same numbers the RFC gives.
_RFC_VECTORS = {
    59: "287082",
    1111111109: "081804",
    1111111111: "050471",
    1234567890: "005924",
    2000000000: "279037",
    20000000000: "353130",
}


class TestFromEnv:
    def test_missing_secret_is_none(self):
        assert TotpSecret.from_env({}) is None

    def test_blank_secret_is_none(self):
        assert TotpSecret.from_env({"QA_TOTP_SECRET": "   "}) is None

    def test_invalid_base32_is_none_not_raise(self):
        # Fails closed like ImapMailbox.from_env: absent tool, never a crash.
        assert TotpSecret.from_env({"QA_TOTP_SECRET": "not-valid-base32!!"}) is None

    def test_lowercase_and_spaces_tolerated(self):
        # Sites commonly show the secret in groups, lowercase or upper.
        spaced = " ".join(_RFC_SECRET_B32[i : i + 4] for i in range(0, len(_RFC_SECRET_B32), 4))
        assert TotpSecret.from_env({"QA_TOTP_SECRET": spaced.lower()}) is not None

    def test_valid_secret_parses(self):
        secret = TotpSecret.from_env({"QA_TOTP_SECRET": _RFC_SECRET_B32})
        assert secret is not None
        assert secret.key == b"12345678901234567890"


class TestCodeMatchesRfc6238:
    def test_published_vectors(self):
        secret = TotpSecret.from_env({"QA_TOTP_SECRET": _RFC_SECRET_B32})
        for t, expected in _RFC_VECTORS.items():
            assert secret.code(t) == expected, f"mismatch at t={t}"

    def test_crosses_a_step_boundary(self):
        # Same 30s window either side of 59 must be identical; the next window
        # must differ. A step-boundary bug (off-by-one on the counter) would
        # pass isolated single-timestamp tests but fail exactly here.
        secret = TotpSecret.from_env({"QA_TOTP_SECRET": _RFC_SECRET_B32})
        assert secret.code(30) == secret.code(59)
        assert secret.code(60) != secret.code(59)


class TestScrubsLoadedSecret:
    # Mirrors test_secret_vars.py's TestScrubsLoadedSecrets: once the secret or
    # a generated code sits in `sensitive`, scrub must strip it from any text.
    def test_generated_code_is_redacted_from_emitted_text(self):
        secret = TotpSecret.from_env({"QA_TOTP_SECRET": _RFC_SECRET_B32})
        code = secret.code(59)
        sensitive = {"totp_code": code}
        assert redact.scrub(f"agent typed {code}", sensitive) == "agent typed <redacted:totp_code>"

    def test_raw_secret_is_redacted_from_emitted_text(self):
        sensitive = {"totp_secret": _RFC_SECRET_B32}
        text = f"enrolment secret was {_RFC_SECRET_B32}"
        assert redact.scrub(text, sensitive) == "enrolment secret was <redacted:totp_secret>"
