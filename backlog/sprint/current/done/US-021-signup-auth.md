# US-021 — Signup & login (multi-user auth)

**As a** visitor, **I want** to sign up and log in to the hosted QAssist, **so that** I get my own tests, runs, and API keys without the operator provisioning anything by hand.

- **Status:** ✅ Done — auth backend + tenant isolation (`6ec5f77`),
  login-screen frontend (2026-07-24), and per-user API-key create/revoke
  (2026-07-24). All acceptance criteria met.
- **Priority:** P1 (next sprint) — required for the hosted paid tier; also
  useful to self-hosters who want multiple users
- **Estimate:** ~1–2 days
- **Depends on:** US-009 (Postgres `users`/`api_keys` tables), US-007 (public
  HTTPS — login links need a real URL), Resend account (shared with US-012)

## Design decision (2026-07-22)

**Magic-link email auth, no passwords.** Rationale: Resend is already in the
stack for US-012, and dropping passwords deletes the whole
reset/strength/hashing surface — the right trade for a solo-dev v1. Flow:
enter email → signed one-time link (short expiry) → session cookie.

This lives in the **public repo** — multi-user auth is a single-tenant
self-host feature too (a team sharing one instance). Only billing gates the
paid tier (US-022).

## Details

- `POST /api/auth/request-link` (rate-limited) → Resend email with signed
  token; `GET /api/auth/verify?token=…` → sets HTTP-only session cookie,
  creates the `users` row on first login (signup == login).
- Sessions: signed cookie (e.g. `SESSION_SECRET` env), no session table
  needed at this scale; revocation = secret rotation, acceptable for v1.
- Per-user API tokens: UI to create/revoke rows in `api_keys` (already in
  001_init.sql) — these are what CI (US-008) uses as bearer tokens.
- `WORKER_API_TOKEN` becomes the self-host/single-user fallback: if no
  Postgres or auth not configured, current behavior is unchanged.
- All `tests`/`runs` queries become user-scoped once auth exists.

## Acceptance criteria

- [x] New visitor can sign up with just an email and reach their dashboard
- [x] Magic-link tokens are single-use and expire (≤15 min)
- [x] A user only ever sees their own tests, runs, and artifacts
- [x] API keys can be created/revoked in the UI and work as bearer tokens
- [x] Self-host without auth configured behaves exactly as today

## Progress

- **Backend + tenant isolation** (`6ec5f77`): magic-link crypto, session
  cookie (30-day TTL), single-use login-token consume, per-request user
  scoping. Assertion-first for the cookie, the consume, and cross-tenant
  isolation.
- **Login-screen frontend** (2026-07-24): `Login.jsx` (email → magic link →
  "check your email"), App gates the whole app on `/api/auth/me` in multi
  mode, Settings shows the signed-in account + sign-out. Progressive
  disclosure holds — token/open self-host renders exactly as before.
- **Dev mail transport** (`MAIL_DEV_CONSOLE`): logs sign-in links to the
  server console so the flow is testable locally without Resend.
- **Per-user API keys** (2026-07-24): `auth.mintApiKey` (prefixed `qak_`
  token, sha256 hash stored, plaintext returned once), `routes/keys.js`
  (create/list/revoke, tenant-scoped, 404 unless multi-user), and an
  `ApiKeys.jsx` section in Settings. Assertion-first in `api-keys.test.js`
  (plaintext-once, hash-only-stored, minted key authenticates, revoked key
  refused, cross-tenant revoke 404) — added a row to
  `backlog/correctness-critical.md`.
- **Follow-up (US-008):** `CiCommand.jsx` still prints
  `Authorization: Bearer $WORKER_API_TOKEN`; in multi-user mode CI should use a
  per-user key from here instead. Left for the CI story.
