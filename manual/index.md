---
layout: home

hero:
  name: QAssist
  text: User manual
  tagline: Learn how to run browser tests, write effective instructions, read verdicts, and configure QAssist.
  actions:
    - theme: brand
      text: Start with your first run
      link: /first-run
    - theme: alt
      text: Open QAssist
      link: https://app.qassist.run

features:
  - title: Getting started
    details: Run a browser test and understand the result.
    link: /first-run
    linkText: Run your first test
  - title: Building a test suite
    details: Save tests, organize coverage, and provide variables or files.
    link: /saved-tests
    linkText: Save a test
  - title: Running automatically
    details: Use schedules, CI triggers, and email notifications.
    link: /schedules
    linkText: Set up a schedule
---

## Browse the manual

### Start here

- [Your first run](./first-run.md) — go from a ready instance to a verdict.
- [Writing instructions](./writing-instructions.md) — describe an outcome the
  agent can check reliably.
- [Reading a verdict](./reading-a-verdict.md) — understand statuses, evidence,
  errors, recordings, and reports.

### Create reusable tests

- [Saving a test](./saved-tests.md)
- [What a test remembers](./run-memory.md)
- [Projects, modules, and suites](./organizing.md)
- [Variables and secrets](./variables.md)
- [Files a run can upload](./files.md)

### Run tests without opening QAssist

- [Schedules](./schedules.md)
- [Triggering from CI](./ci.md)
- [Email notifications](./notifications.md)

### Test real applications

- [Testing behind a login](./saved-sessions.md)
- [Controlling where a run may go](./navigation-fence.md)
- [Troubleshooting a run](./troubleshooting.md)

### Run your own instance

- [Self-hosting](./self-hosting.md)
- [Instance settings](./settings.md)

Contributor documentation, including architecture and deployment, lives in the
[`docs/` directory](https://github.com/rszhd/qassist/tree/main/docs) in the
project repository.
