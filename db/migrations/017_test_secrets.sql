-- 017_test_secrets.sql — US-064: the value behind a `secret` declaration.
--
-- US-035 stores a secret variable's *declaration* in `tests.variables` and
-- deliberately no value: the real one arrives per run, from the override dialog
-- or a CI body. A schedule fires while nobody is present and has neither
-- channel, so the one test that must type a real credential on every run — the
-- login test that PRODUCES a session (015) and therefore cannot use one — could
-- never run on a schedule at all.
--
-- So the guarantee is amended rather than dropped, and the amended sentence
-- lives in `server/src/variables.js`'s header: a secret's value is never
-- persisted UNENCRYPTED, never returned by any endpoint, and never denormalized
-- onto a run. `runs.variables` still carries `'<secret>'` and nothing else.
--
-- A table of its own, NOT a field inside the `tests.variables` jsonb, and the
-- reason is the whole point of the shape. `variables` is in the `COLS` constant
-- every test endpoint selects, so ciphertext living inside it would ship in
-- every response body and masking would become a discipline repeated at four
-- sites forever — the fifth site added next year inherits the leak. Here the
-- ciphertext is in a column nothing that answers a request selects, so "it never
-- reaches a response" holds by construction. It also keeps the same `bytea`
-- envelope crypto.js already puts a BYOK key (005) and a session blob (015) in,
-- rather than base64 inside jsonb.
--
-- Keyed by NAME, which is what makes the read path need no decryption at all:
-- the editor's set / not-set state is `select name`, so plaintext exists only
-- between `secretsForTests` and `resolveForRun`, on the paths that start a run.
create table test_secrets (
  test_id uuid not null references tests(id) on delete cascade,
  -- The declaration this fills, matched on `tests.variables[].name`. A rename
  -- therefore orphans the value and the variable reads as not-set, which is the
  -- honest answer: the value cannot be read back to carry across a rename, so
  -- the alternative is a stored secret silently answering to a new name.
  name text not null,
  value_ciphertext bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (test_id, name)
);
