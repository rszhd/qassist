# US-005 — Bring-your-own OpenAI key (BYOK)

**As a** user, **I want** to run tests with my own OpenAI API key, **so that** I control model cost and rate limits instead of sharing the operator's key.

- **Status:** ✅ Shipped (2026-07-25). Decision made 2026-07-21; pulled into the
  current sprint 2026-07-22, to next 2026-07-23, back into current 2026-07-25 and
  built as an account-stored (encrypted) key plus a per-request override.
- **Priority:** P1 (next sprint) — prerequisite for offering the service to
  others; removes the operator's token bill and OpenAI rate-limit ceiling as
  scaling limits. On the paid tier, payment covers hosting — LLM tokens are
  the user's own key (see US-022).
- **Estimate:** ~half a day (API + UI + hardening)
- **Depends on:** — (US-009's `users.openai_key_ciphertext` adds stored
  encrypted keys; per-request keys work without it)

## Details

- **Two key sources, resolved request > stored > server** (decided 2026-07-25):
  - **Account-stored** (the UI path): a per-user key set in Settings, encrypted
    at rest in `users.openai_key_ciphertext` (US-009's column). Set/clear/read
    via `PUT`/`DELETE`/`GET /api/account/openai-key`; `/api/auth/me` carries the
    set-state. The value is never returned by any read, decrypted server-side
    only to spawn the agent.
  - **Per-request** (programmatic path): `POST /api/runs` (and the saved-test /
    suite / module / project run routes) accept an optional `openai_api_key`
    that wins over the stored key for that run.
  - The server's `OPENAI_API_KEY` remains the fallback when a run resolves no
    user key — so self-host is unchanged.
- Encryption uses a dedicated `KEY_ENCRYPTION_SECRET` (AES-256-GCM), separate
  from `SESSION_SECRET` so session rotation can't brick stored keys.
- The original "localStorage, never persisted" plan was for the pre-US-009
  world; with the control plane here, the key is an account setting.

## Hardening (required)

- [x] **Hard wall-clock timeout per run** (`RUN_TIMEOUT_SECONDS`, default 600):
      a `setTimeout` watchdog beside the memory one kills the tree and reports
      failed — `MAX_STEPS` bounds steps, not time
- [x] Never log the key; the resolved key travels only into the child's env
      `OPENAI_API_KEY` — never `report_data.json`, events, or the persisted row
      (`openai_api_key` is a run field `persistInsert`/`broadcast` never read)
- [x] Validate the key shape up front (`sk-…`); a malformed key is a 400 before
      any store or run

## Acceptance criteria

- [x] Run works end-to-end with a user-supplied key; server key not used
- [x] Key appears in no logs, events, artifacts, or API responses
- [x] Invalid key → run fails quickly with an actionable message
- [x] Stuck run is killed at the wall-clock limit and reported as failed

## Shipped (2026-07-25)

- Backend: `crypto.js` (AES-256-GCM), `openaiKey.js` (persist + `resolveRunKey`
  precedence), `routes/account.js`, `/api/auth/me` set-state, run-engine
  threading + wall-clock watchdog, gate `requireAgentKey` resolves request+stored,
  scheduler uses the owner's stored key.
- Frontend: `OpenaiKey.jsx` in the account settings section (multi-user only).
- Correctness-critical (secret-at-rest): assertion-first, reviewed before the
  code — `openai-key.test.js` (pure) + `openai-key-postgres.test.js` (real PG).
  Row added to `backlog/correctness-critical.md`.
- **Known follow-up:** on a pure-BYOK hosted instance (no server `OPENAI_API_KEY`)
  the scheduler still refuses to *start* (`startScheduler` guard) — fine while a
  server key is present; revisit with the hosted tier (US-022/US-028).
