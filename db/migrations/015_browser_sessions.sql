-- 015_browser_sessions.sql — US-043: test what is behind the login.
--
-- A saved session is a Playwright `storageState` — cookies plus localStorage —
-- that a run's browser starts with, so a test lands already authenticated
-- instead of spending its first six steps and forty seconds on the login form
-- it is not testing.
--
-- Inert on the day it lands, like 013 and 014: every project that exists reads
-- as "no sessions and no preamble", every test as "no session", and no existing
-- row needs a backfill because the correct value for all of them is the default.
--
-- Named `browser_sessions`, not `sessions`. US-021 already means something else
-- by the word — a signed login cookie for a QAssist user — and the two are
-- adjacent enough in conversation that a table called `sessions` would be read
-- wrong by whoever is next in here at 2am.

create table browser_sessions (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name       text not null,
  -- Case-folded uniqueness, stored rather than expressed as a functional index,
  -- for 014's reason: the test harness strips `create unique index`, so the
  -- constraint that matters would be absent exactly where the tests run.
  name_key   text not null,

  -- The blob, and the only column that matters. AES-256-GCM via
  -- crypto.js's encryptSecret — the same envelope US-005 puts a BYOK key in,
  -- deliberately, because these two are the same kind of thing: a credential we
  -- hold on someone's behalf and must be able to hand to a spawn.
  --
  -- A session blob IS the credential. Holding one is being logged in, with no
  -- password to steal and no second factor left to clear. So it is never
  -- returned by any read endpoint, and the columns beside it exist precisely so
  -- that it does not have to be: a user needs to tell a live session from a
  -- stale one, and counts plus a capture time are enough to do that.
  -- Both of these are relaxed to nullable by 016 — see that file for why. This
  -- one is left exactly as it was applied: a migration that has run anywhere
  -- must never be edited afterwards, because `schema_migrations` will not
  -- re-run it and the edit then exists only in the file.
  storage_state_ciphertext bytea not null,
  cookie_count int not null default 0,
  origin_count int not null default 0,
  captured_at  timestamptz not null default now(),

  -- How this blob was produced. 'pasted' is the escape hatch that makes the
  -- feature useful on day one — and covers the SSO flows an agent will never
  -- survive; 'login_run' is the product.
  source text not null default 'pasted' check (source in ('pasted', 'login_run')),

  -- The test whose job is to authenticate. A passing run of it refreshes this
  -- row, which makes "the session went stale" a thing the existing scheduler
  -- already fixes nightly, with no new machinery. `set null` rather than
  -- cascade: deleting the login test must not delete a working session.
  login_test_id uuid references tests(id) on delete set null,

  -- How a run tells "we are still signed in" from "we are looking at a login
  -- page" (AC #4). Both optional: a pasted blob for an SSO app may have no
  -- stable landing URL, and a session with neither simply skips the check and
  -- behaves as a run does today.
  --
  -- Checked BEFORE the first LLM step, so an expired session costs a verdict
  -- and not a wandering twenty-step failure whose report blames the goal.
  verify_url_contains text,
  verify_text         text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, name_key)
);

create index browser_sessions_project_idx on browser_sessions (project_id);

-- A test opts in. `set null` so deleting a session leaves its tests runnable
-- and merely unauthenticated — the alternative deletes a customer's tests
-- because they tidied up a credential.
alter table tests
  add column if not exists browser_session_id uuid references browser_sessions(id) on delete set null;

-- The per-project preamble (AC #5): deterministic browser-use `initial_actions`
-- executed before the agent's first LLM step, at zero token cost. Useful on its
-- own without any session — "dismiss the cookie dialog, close the promo modal"
-- is two wasted steps on every run in the project, every night, forever.
--
-- jsonb and validated in the app, as 005 does for `tests.variables` and for the
-- same reason. Cast default, as 013 and 004 both explain: pg-mem hands an
-- uncast default back as the *string* "[]", and the API would then answer a
-- different shape there than on a real server.
alter table projects
  add column if not exists initial_actions jsonb not null default '[]'::jsonb;

-- `runs.failure_reason` (013) gains a second value, `session_expired`, and
-- needs no schema change: it is deliberately un-constrained text, and an
-- expired session is a `failed` run exactly as a fenced one is. The point of
-- the column is that something machine-readable survives to the row, because
-- CI (US-008), the mailer (US-012) and the PDF all read the row and not prose.
