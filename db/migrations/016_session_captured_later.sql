-- 016_session_captured_later.sql — US-043: a session may exist before it holds
-- anything.
--
-- 015 required a blob at creation. That made pasting a Playwright
-- `storageState.json` a PREREQUISITE for the login-run route, which is
-- backwards: the login run is the product and the paste is the escape hatch for
-- teams that already have the file. Under 015 the only way to reach the product
-- was to first produce by hand the very file it exists to make unnecessary — so
-- anyone who had never used Playwright could not use the feature at all.
--
-- Its own migration rather than an edit to 015, and that is the part worth
-- keeping. 015 had already been applied, and `schema_migrations` does not
-- re-run a file it has recorded, so editing it in place left the change
-- existing only in the repo: every fresh install correct, every environment
-- that had already run 015 silently unchanged and answering 500 on the new
-- path. The rule holds even for a migration that is one day old and
-- uncommitted, because "has this already run somewhere" is not a question the
-- file can answer about itself — the answer lives in each database.

-- Null ciphertext is a real, VISIBLE state: "created, waiting for its login test
-- to capture it". It is never a silent one — a test that opts into an
-- uncaptured session is refused at run start rather than quietly run signed
-- out, because a test that runs signed out passes nothing and fails everything
-- while the report blames the goal (`sessionsForTests` in browserSession.js).
alter table browser_sessions alter column storage_state_ciphertext drop not null;

-- And the timestamp with it, default included: "never captured" and "captured
-- this second" must not read identically on the row a user judges freshness
-- from. A null here is what the UI reads as "not captured yet".
alter table browser_sessions alter column captured_at drop not null;
alter table browser_sessions alter column captured_at drop default;
