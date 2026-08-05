---
layout: home

hero:
  name: QAssist
  text: Write instructions. Read a verdict.
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
    details: A test is a sentence, not a script. When a button moves or a class name changes, the agent can still find it without a selector rewrite.
  - title: You watch it happen
    details: The browser session streams to the page while the run works and, when recording is enabled, can be watched again later.
  - title: A verdict with reasons
    details: A finished run records its status, a written summary, the agent's activity, and any failed requests or console errors the page produced.
  - title: Yours to run
    details: Self-hosting is free, for anything, forever. Model tokens are bring-your-own on every tier, so you keep control of model spend.
---

## What this manual covers

This is the manual for **using** QAssist. It follows the path a test usually
takes: write one set of instructions, save it, group it, give it credentials,
schedule it, and
eventually use it to gate a deploy.

- **New here?** [Your first run](./first-run.md) gets you from a ready instance
  to a verdict in about five minutes.
- **A run keeps failing and you think it shouldn't?**
  [Writing instructions](./writing-instructions.md) is almost always the answer, and
  [When a run goes wrong](./troubleshooting.md) covers the rest.
- **Running your own instance?** [Self-hosting](./self-hosting.md) and
  [Settings](./settings.md).

Notes on the internals — schema rules, the deployment chain, the design system,
the test philosophy — are not here. They live in
[`docs/`](https://github.com/rszhd/qassist/tree/main/docs) in the repository and
are written for someone editing the code.
