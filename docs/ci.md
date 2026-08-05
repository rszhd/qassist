# Running QAssist from CI/CD

**Moved to the user manual: <https://docs.qassist.run/ci.html>** (source:
[`manual/ci.md`](../manual/ci.md)).

The pipeline step for US-008 — what a job may trigger, the three things the
request body does, what to gate on, the `curl`-plus-poll script, and ready-made
GitHub Actions and GitLab CI jobs. All of it is written for someone wiring their
own pipeline, which is a user rather than a contributor, so US-070 moved it to
the site published off `dev`.

Not duplicated here on purpose: two copies of a script people paste is one copy
that is wrong.

Two decisions worth naming, since they are the ones people arrive here
disagreeing with, and both are argued in full on that page:

- **A pipeline triggers a module or a suite, never a single test or a whole
  project.** One goal is not a gate; every test there is belongs to a
  [schedule](api.md#schedules).
- **`cancelled` does not fail the build.** A stopped run is somebody deciding it
  was not worth finishing, not a verdict about the deploy — with the tradeoff
  stated, and the one-line change for pipelines that gate a release.

The endpoints themselves stay in [`api.md`](api.md), which is the HTTP surface
rather than the integration.
