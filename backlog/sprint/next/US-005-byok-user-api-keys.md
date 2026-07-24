# US-005 — Bring-your-own OpenAI key (BYOK)

**As a** user, **I want** to run tests with my own OpenAI API key, **so that** I control model cost and rate limits instead of sharing the operator's key.

- **Status:** 📋 Planned (decision made 2026-07-21; pulled into current sprint
  2026-07-22, then moved to next sprint on 2026-07-23 — it is a *hosted*-tier
  launch requirement, and a self-hoster already supplies the one key their
  instance uses)
- **Priority:** P1 (next sprint) — prerequisite for offering the service to
  others; removes the operator's token bill and OpenAI rate-limit ceiling as
  scaling limits. On the paid tier, payment covers hosting — LLM tokens are
  the user's own key (see US-022).
- **Estimate:** ~half a day (API + UI + hardening)
- **Depends on:** — (US-009's `users.openai_key_ciphertext` adds stored
  encrypted keys; per-request keys work without it)

## Details

- `POST /api/runs` accepts an optional `openai_api_key` (+ optional `model`);
  server passes it to the spawned agent via env (current pattern). Fall back to
  the server's key only if configured/allowed.
- UI: key field (kept in localStorage, never sent anywhere but the run request).
- Until US-009 exists, keys are per-request and never persisted server-side.

## Hardening (required)

- [ ] **Hard wall-clock timeout per run** (e.g. 10 min): a slow or rate-limited
      user key otherwise squats a browser slot while retrying 429s —
      `MAX_STEPS` bounds steps, not time
- [ ] Never log the key; ensure Express never echoes child env in errors;
      keep it out of `report_data.json` and events
- [ ] Validate the key shape up front; fail fast with a clear error event if
      OpenAI rejects it on the first call

## Acceptance criteria

- [ ] Run works end-to-end with a user-supplied key; server key not used
- [ ] Key appears in no logs, events, artifacts, or API responses
- [ ] Invalid key → run fails quickly with an actionable message
- [ ] Stuck run is killed at the wall-clock limit and reported as failed
