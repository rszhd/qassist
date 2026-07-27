-- 012_user_concurrency_override.sql — US-058: one account's concurrent-run cap,
-- set without moving anyone else's. Inert on an instance that never writes it:
-- null is "no override", every existing row is already in that state, and with
-- MAX_CONCURRENT_PER_USER also unset nothing reads the column at all.

-- Nullable and no default, deliberately: a default here would be a second place
-- the instance-wide number lives, and the resolution order (concurrency.js) has
-- exactly one — override, else MAX_CONCURRENT_PER_USER, else uncapped.
--
-- `> 0` because zero is not a small budget, it is a suspension: an account that
-- may never run is a different feature, and the refusal a cap of 0 produces
-- tells the user to "wait for one to finish", which would never come true. The
-- floor is 1, which is still a real throttle. A cap ABOVE
-- MAX_CONCURRENT_SESSIONS is allowed and simply never binds — the global gate
-- wins either way, and a constraint cannot see an env var to reject it here.
--
-- Written by one statement in the codebase (concurrency.js
-- `writeUserConcurrencyCap`), the way 010's activated_at is by activateByEmail.
alter table users add column max_concurrent_runs int;

-- Two statements, and the constraint is named, for two separate reasons.
-- pg-mem cannot parse an inline `check` inside an `alter table add column`
-- against this schema at all ("Corrupted alias"), so the one-liner form breaks
-- every test that migrates in memory — and it does not enforce this constraint
-- once it does parse, which is why `> 0` is asserted against a real server
-- (concurrency-override-postgres.test.js) and could not be asserted anywhere
-- else. Named because an anonymous check is named differently by each engine,
-- so a future `drop constraint` would silently no-op on one of them (US-047
-- learned that the hard way on runs_status_check).
alter table users
  add constraint users_max_concurrent_runs_check check (max_concurrent_runs > 0);
