-- 006_login_tokens.sql — US-021 magic-link auth
-- One row per emailed login link. We store only the sha256 of the secret that
-- went in the URL (never the secret itself), so a database read can't mint a
-- session. Single-use + expiry are enforced by the atomic consume in
-- src/auth.js (update … where used_at is null and expires_at > now() returning).
--
-- Keyed on email, not user_id: signup == login, so the user row may not exist
-- until the link is consumed. Sessions are stateless signed cookies (US-021
-- design decision) — there is deliberately no sessions table.

create table login_tokens (
  token_hash text primary key,                 -- sha256 hex of the URL secret
  email      text not null,                     -- lowercased; who the link logs in
  expires_at timestamptz not null,
  used_at    timestamptz,                       -- non-null once redeemed (single-use)
  created_at timestamptz not null default now()
);

-- Sweep of expired/used links (housekeeping only; consume never trusts it).
create index login_tokens_expiry_idx on login_tokens (expires_at);
