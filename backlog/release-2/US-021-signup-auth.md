# US-021 — Signup & login (multi-user auth)

**As a** visitor, **I want** to sign up and log in to the hosted QAssist, **so that** I get my own tests, runs, and API keys without the operator provisioning anything by hand.

- **Status:** 📋 Planned (moved to Release 2 on 2026-07-23 with the rest of the
  hosted tier)
- **Priority:** P1 (Release 2) — required for the hosted paid tier; also
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

- [ ] New visitor can sign up with just an email and reach their dashboard
- [ ] Magic-link tokens are single-use and expire (≤15 min)
- [ ] A user only ever sees their own tests, runs, and artifacts
- [ ] API keys can be created/revoked in the UI and work as bearer tokens
- [ ] Self-host without auth configured behaves exactly as today
