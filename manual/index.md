---
layout: home

hero:
  name: QAssist
  text: Write a goal. Read a verdict.
  tagline: Browser testing with no selectors and no scripts. Describe what should happen in plain English; an AI agent drives a real Chromium, streams it live, and decides whether it happened.
  image:
    src: /qassist-mark.svg
    alt: QAssist
  actions:
    - theme: brand
      text: Your first run
      link: /first-run
    - theme: alt
      text: Watch a real run
      link: https://demo.qassist.run
    - theme: alt
      text: Run it yourself
      link: /self-hosting

features:
  - title: No selectors to maintain
    details: A test is a sentence, not a script. When the button moves or the class name changes, the agent still finds it — there is nothing to update.
  - title: You watch it happen
    details: The browser session streams to the page while the run works, at about six frames a second, and is recorded so you can watch it back later.
  - title: A verdict with reasons
    details: Every run ends passed or failed with a written rationale, the step list the agent took, and the failed requests and console errors the page produced.
  - title: Yours to run
    details: Self-hosting is free, for anything, forever. Model tokens are bring-your-own on every tier, so the only bill is the one you already have.
---

## What this manual covers

This is the manual for **using** QAssist. It follows the path a test actually
takes: one goal typed into a box, then the same goal saved, grouped, given
credentials, scheduled, and finally gating a deploy.

- **New here?** [Your first run](./first-run.md) gets you a verdict in about
  five minutes, whether you are on a hosted instance or your own box.
- **A run keeps failing and you think it shouldn't?**
  [Writing a goal](./writing-goals.md) is almost always the answer, and
  [When a run goes wrong](./troubleshooting.md) covers the rest.
- **Running your own instance?** [Self-hosting](./self-hosting.md) and
  [Settings](./settings.md).

Notes on the internals — schema rules, the deployment chain, the design system,
the test philosophy — are not here. They live in
[`docs/`](https://github.com/rszhd/qassist/tree/main/docs) in the repository and
are written for someone editing the code.
