# US-048 — Test a flow that uploads a file

**As** someone testing an app with an upload step, **I want** the agent to be
able to attach a file, **so that** "upload your CV and submit" is a goal QAssist
can execute rather than one it gets stuck on.

- **Status:** 📋 Planned.
- **Priority:** P3 among the unscheduled work. Narrow, but it is a hard *no*
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

- [ ] A project can hold fixture files, uploaded and managed in the UI, with a
      size cap and a total quota
- [ ] A test whose goal names a fixture completes an upload flow end to end
      against a fixture page
- [ ] The agent can attach *only* project fixtures — an attempt at any other path
      fails, proven with a path traversal and an absolute path to a real file in
      the container
- [ ] Fixtures survive artifact retention and are deleted with their project
- [ ] Fixture bytes never enter `report_data.json`, an event or the PDF (the
      filename may)
