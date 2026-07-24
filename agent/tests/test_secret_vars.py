"""Unit tests for secret_vars.load — the agent's QA_VARS ingest (US-035).

Secret per-run variables reach the agent as a JSON `QA_VARS` env (never inside
QA_GOAL). `secret_vars.load` parses it into the `sensitive` dict browser-use
already uses for US-034, so `<secret>name</secret>` placeholders in the goal
substitute at type-time and `redact.scrub` strips the real value from every
emitted field. Pure stdlib — no browser, IMAP or network — like email_codes.

Correctness-critical (secret-variable row in backlog/correctness-critical.md):
a malformed or partial QA_VARS must fail closed (empty, never half-applied), and
a loaded secret must be redactable — the last test ties the ingest to the guard.
"""
import secret_vars
import redact


class TestLoad:
    def test_parses_qa_vars_json(self):
        assert secret_vars.load({"QA_VARS": '{"pw": "s3cret"}'}) == {"pw": "s3cret"}

    def test_missing_env_is_empty(self):
        assert secret_vars.load({}) == {}

    def test_empty_env_is_empty(self):
        assert secret_vars.load({"QA_VARS": ""}) == {}

    def test_malformed_json_is_empty_not_crash(self):
        # A bad QA_VARS must never take a run down or, worse, half-apply.
        assert secret_vars.load({"QA_VARS": "{not json"}) == {}

    def test_non_object_json_is_empty(self):
        assert secret_vars.load({"QA_VARS": '"just a string"'}) == {}
        assert secret_vars.load({"QA_VARS": "[1, 2]"}) == {}

    def test_non_string_values_dropped(self):
        assert secret_vars.load({"QA_VARS": '{"pw": "ok", "n": 5}'}) == {"pw": "ok"}

    def test_empty_value_dropped(self):
        # An empty secret must not enter `sensitive`; scrub would otherwise treat
        # "" as ever-present and redact nothing useful (see test_redact).
        assert secret_vars.load({"QA_VARS": '{"pw": ""}'}) == {}


class TestScrubsLoadedSecrets:
    # The whole point of loading them: once merged into `sensitive`, scrub strips
    # them from every emitted field. This ties the ingest to the redaction guard.
    def test_loaded_secret_is_redacted_from_emitted_text(self):
        sensitive = secret_vars.load({"QA_VARS": '{"pw": "s3cret"}'})
        assert redact.scrub("agent typed s3cret", sensitive) == "agent typed <redacted:pw>"
