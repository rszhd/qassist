-- 018_extension_session_capture.sql — US-063: capture a session without a
-- terminal.
--
-- The paste route (015) needs Node, a terminal and Playwright — tooling the
-- audience for social login (a manual QA, an app owner) does not have. This
-- adds a third way to fill a `browser_sessions` row: a browser extension
-- reads cookies + localStorage out of a browser the user is already signed
-- in to and posts the result to a single-use, session-scoped token minted
-- from the UI.
--
-- Two changes, both additive. 015 is never edited — see its own header and
-- 016's for why: a migration applied anywhere cannot be un-applied by editing
-- the file, only fixed forward.

-- `source` gains 'extension' alongside 'pasted' and 'login_run'. Dropped
-- under both engines' names, as 004 and 011 do: Postgres calls an inline
-- column check `browser_sessions_source_check`; pg-mem (the test harness)
-- numbers checks per table in declaration order and `source` is the only
-- check constraint 015 declares, so pg-mem calls it `browser_sessions_
-- constraint_1`. `if exists` makes each line a no-op on the engine that uses
-- the other name.
alter table browser_sessions drop constraint if exists browser_sessions_source_check;
alter table browser_sessions drop constraint if exists browser_sessions_constraint_1;

alter table browser_sessions add constraint browser_sessions_source_check
  check (source in ('pasted', 'login_run', 'extension'));

-- The token itself. Single-use and session-scoped, the same shape as
-- `login_tokens` (006) and consumed the same atomic way: `update … where
-- token_hash = $1 and used_at is null and expires_at > now()`. This table IS
-- the "token that can post a session and do nothing else" the story's
-- acceptance criteria ask for — it is checked by exactly one route
-- (`POST /api/capture`) and grants no access to anything else, unlike an
-- `api_keys` row, which is full-privilege for the user who owns it.
create table session_capture_tokens (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references browser_sessions(id) on delete cascade,
  token_hash text not null unique,
  -- Informational only — who minted it, for an audit trail. `set null` rather
  -- than cascade: the token's claim is scoped by session_id, not by the user
  -- who happened to mint it, so a deleted user must not take a live token
  -- (and the row it can still write to) down with them.
  created_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index session_capture_tokens_session_idx on session_capture_tokens (session_id);
