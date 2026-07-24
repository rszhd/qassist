-- US-036: demo sandbox tenants. On an AUTH_MODE=demo deployment every visitor
-- is a fresh, short-lived user seeded with fake data. demo_expires_at marks such
-- a tenant and says when the reaper may delete it (along with its run rows and
-- artifact dirs — runs.user_id is `on delete set null`, so a plain user delete
-- would orphan them). Null = a normal, permanent user (self-host / magic-link),
-- which the reaper never touches. Partial index so the reaper's expiry scan
-- reads only demo rows, not every user on the instance.
alter table users add column demo_expires_at timestamptz;
create index users_demo_expires_idx on users (demo_expires_at)
  where demo_expires_at is not null;
