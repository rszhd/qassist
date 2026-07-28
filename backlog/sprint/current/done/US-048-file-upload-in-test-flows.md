# US-048 — Test a flow that uploads a file

**As** someone testing an app with an upload step, **I want** the agent to be
able to attach a file, **so that** "upload your CV and submit" is a goal QAssist
can execute rather than one it gets stuck on.

- **Status:** ✅ Done 2026-07-27 (pulled up from `sprint/next/` the same day it
  was scheduled). 5/5 acceptance criteria — the end-to-end upload was verified
  by hand against a real page, since it needs a live browser; see Results.
- **Priority:** was P3 of the next sprint. Narrow, but it is a hard *no*
  today, and a hard no is what makes someone conclude the tool cannot test their
  app.
- **Estimate:** ~3–4 h (storage, the profile wiring, a UI to attach fixtures).
- **Depends on:** US-035 (a fixture is per-project setup data, same shape as a
  variable), US-023 (it belongs to a project).

## Why now

browser-use ships an `upload_file` action in the default tool registry, gated by
`Agent(available_file_paths=…)` — a whitelist of paths the agent may attach.
We pass `None`, so the action has nothing to offer and any flow with a file
input dead-ends.

Upload appears in a lot of the flows people most want covered: job applications,
KYC/identity, support tickets with a screenshot, CSV import, avatar change,
document signing. These are also flows people are least willing to test by hand,
because they are tedious and involve real-looking files.

## Details

- **A project owns fixture files** (again: a thing a team sets up once, not per
  test). Upload through the Projects view, stored under a per-project directory,
  size-capped, and — importantly — *not* under `runs/<id>/`, so
  `ARTIFACT_RETENTION_DAYS` does not delete a customer's fixture after a week.
- The whitelist passed as `available_file_paths` is the project's fixtures only.
  It is a security boundary as much as a convenience: without it, an agent that
  can be talked into calling `upload_file` on an arbitrary path is a file-read
  primitive pointed at the container — `.env` included.
- The goal text refers to a fixture by name; the agent gets the paths and the
  filenames. Deliberately keep this dumb — no templating, no generation.
- `BrowserProfile.accept_downloads` and `downloads_path` are the mirror case
  (assert that an export produced a file). Same story, opposite direction; worth
  noting here but not necessarily doing in the same pass.

## Acceptance criteria

- [x] A project can hold fixture files, uploaded and managed in the UI, with a
      size cap and a total quota
- [x] A test whose goal names a fixture completes an upload flow end to end
      against a fixture page — **verified manually** (maintainer, 2026-07-27),
      not by an automated test: the last hop is browser-use's `upload_file`
      attaching to a real `<input type=file>`, which needs a live Chromium and a
      funded key. Everything below it is asserted
- [x] The agent can attach *only* project fixtures — an attempt at any other path
      fails, proven with a path traversal and an absolute path to a real file in
      the container
- [x] Fixtures survive artifact retention and are deleted with their project
- [x] Fixture bytes never enter `report_data.json`, an event or the PDF (the
      filename may)


## Results

Assertion-first, as the workflow rule requires for this class: the three test
files were written and reviewed *before* `server/src/fixtures.js` existed, and
the decisions they encode are in `REVIEWER` blocks at the top of each (D1–D7 in
`fixture-path.test.js`, D8–D14 in `fixture-whitelist.test.js`). Row added to
`backlog/correctness-critical.md`.

**The shape.** Fixtures upload as a raw request body with the name in the query
string — `POST /api/projects/:project/fixtures?filename=cv.pdf` — rather than
as multipart. No new dependency, `fetch(url, { body: file })` on the frontend
and `curl --data-binary` in CI, but the real reason is that it leaves exactly
*one* input carrying a filename on a story whose acceptance criterion is that a
path traversal fails. The query string also keeps the name clear of path
splitting and percent-decoding entirely.

**The gate is an allowlisted character class, not a traversal denylist.** A
denylist is a list of the spellings we thought of, and US-042 is the standing
reminder that the table is always longer than it looks. Letters, digits, dot,
underscore, space, dash; first character alphanumeric; NFC-normalized; ≤255
*bytes*. A separator cannot be expressed, so no traversal can be either, and
`.env` is unnameable rather than merely un-traversable. Unicode letters are in
(`Résumé.pdf`, `简历.pdf` are files real customers upload); NFC because macOS
uploads decomposed and Linux composed, and without normalizing at the door one
project holds two fixtures that are identical on screen. The reject table is
asserted on the RAW spellings — `../../.env`, `....//`, `..\`, a null byte, an
RTL override, and the percent-encoded forms the query parser decodes on the way
in — rather than on what a normalizer left behind.

**The trap inside that trap is `path.join` versus `path.resolve`.**
`join(dir, '/etc/passwd')` yields `dir/etc/passwd`, contained and harmless, so a
containment test written against `join` *passes* for an absolute-path input
while a caller that resolves is wide open. Containment is therefore re-asserted
with `resolve`, and the character class is what actually does the work.

**Two things found by reading browser-use rather than by reasoning about it.**
`available_file_paths` gates `read_file`'s external reads on the same exact
membership test as `upload_file` (`tools/service.py:865` and `:1785`), so the
story's "file-read primitive" framing is literally right and the list is one
boundary serving two actions. And the fail-closed direction here is the
*inverse* of US-042's: `[]` genuinely means "allow nothing" for a whitelist
whose test is `path not in list`, so an unreadable `QA_FIXTURES` resolves to
`[]` and the run proceeds unable to attach anything — where `navigation_policy`
must raise, because browser-use reads an empty `allowed_domains` as falsy and
skips the allowlist check entirely. The two modules look alike and must not be
made to behave alike; both docstrings now say so.

**How the last criterion was proven, and why it is not a test.** The maintainer
ran a real upload flow against a real page by hand. Everything beneath that hop
is asserted — the whitelist is built, contains only the owning project's files,
reaches the child as `QA_FIXTURES`, and names each file in the task — but the
hop itself is browser-use driving a live `<input type=file>`, which needs a
Chromium and a funded key and so belongs to the same tier as US-042's redirect
criterion. Worth being precise about which claims rest on a test and which rest
on someone watching it work. **That tier is now
[US-062](../../../unscheduled/US-062-live-browser-test-tier.md)** (2026-07-28);
this criterion is its funded, agent-driven case, which is deliberately not a
merge gate there.

**What the assertion caught that nothing else would have.** `POST
/api/tests/:id/run` builds its own column list instead of sharing
`RUNNABLE_TEST_COLS`, so it silently ran every project's tests with an empty
whitelist while all 566 other tests stayed green. That is the "one forgotten
start path" failure US-036 and US-022 were both specified around, arriving in a
route that already had the US-042 join beside it.

**The retention interaction is a configuration failure, not a code one.**
`retention.js` prunes exactly "a uuid-named directory under `ARTIFACTS_DIR`",
and a fixture directory is uuid-named — it is a project id. So the natural
nested layout deletes a customer's uploads on day seven with no bug anywhere in
the sweep, and no test *of the sweep* would catch it. Hence `fixturesDirConflict`
refusing to boot on an overlap, compared on a path boundary so
`/data/runs-fixtures` is not "inside" `/data/runs`.

**The whitelist is read off disk at spawn, not from the `fixtures` table.** The
rows are metadata for the UI and the quota; the thing that decides what a
browser may open has to be the thing that actually exists. Where the two
disagree — a half-finished delete, a restored volume — disk is the honest
answer, and it keeps `startRun` synchronous at the cost of one `readdir`.

**Deliberately not done:** rename (a goal points at the filename, so renaming
underneath it breaks a saved test silently), replace-on-duplicate (409 instead —
silently changing what a saved test attaches is invisible in history), and
`accept_downloads`/`downloads_path`, the mirror case the story names. That one
is a separate story: same machinery, opposite direction, and it wants its own
acceptance criteria about asserting an export *produced* a file.

## Later

- **The download half.** `BrowserProfile.accept_downloads` + `downloads_path`,
  so "export the report and check the CSV has 12 rows" is a goal. Note that
  browser-use already appends downloaded files to `available_file_paths` at
  runtime (`agent/service.py:672`), so the whitelist this story built is the
  thing that story extends rather than something it works around.
- **Fixtures in the report.** A run that attached a file says so nowhere in the
  PDF. The filename is safe to render (the bytes are not), and "attached
  cv.pdf at step 4" is the evidence someone reviewing an upload test wants.
