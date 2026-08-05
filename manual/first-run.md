# Your first run

About five minutes to a verdict. There is nothing to install on your machine —
a run happens in a browser on the QAssist instance, not in yours.

## 1. Get to an instance

Whichever you have:

- **A hosted account** at [app.qassist.run](https://app.qassist.run). Sign in
  with your email address; there is no password, so the link in the mail *is*
  the sign-in.
- **The demo** at [demo.qassist.run](https://demo.qassist.run). No signup and no
  key — it is the fastest way to see a run happen, and nothing you make there
  outlives your visit.
- **Your own instance**, which is [one compose file and one
  secret](./self-hosting.md).

## 2. Add your OpenAI key

Open **Settings → OpenAI key** and paste yours.

This is not optional and it is not a formality. Every run is funded by the key
you store, on every tier — QAssist holds no key of its own, so an instance you
share with your team can never spend your tokens on someone else's runs. Until a
key is stored, starting a run answers *no OpenAI key: add yours in Settings*.

The key is stored encrypted and never shown again. Settings tells you a key is
set; it will not show you which one.

::: tip A hosted account has a third step
On an instance that bills, a subscription is the step after the key. It pays for
the browser time on the box — the model spend stays on your own OpenAI account
either way.
:::

## 3. Type a URL and a goal

The **Run** view is two fields and a button.

| Field | What goes in it |
|---|---|
| **URL** | Where the browser opens. `https://example.com` |
| **Goal** | What should be true when it is done, in plain English |

For a first run, pick something with an unambiguous answer:

```
URL   https://example.com
Goal  Confirm the page shows the heading "Example Domain"
```

Press **Run**.

## 4. Watch it

The browser session appears on the page within a few seconds and streams while
the agent works. Under it, each step arrives as the agent takes it: what it was
looking at, what it decided, what it did.

You can leave. The run does not depend on you watching it — closing the tab does
not stop it, and reopening the run picks the stream back up. The one thing
watching changes is cost: frames are only captured while somebody is looking, so
a run nobody is watching skips the encoding entirely.

If you decide it is going nowhere, **Stop** ends it. A stopped run finishes what
it can — its recording and its report — and ends as `cancelled`.

## 5. Read the verdict

When it finishes you get a verdict, a written rationale, the step list, and the
session recording. What each of those is worth, and how to read a `completed`
that is neither a pass nor a fail, is [Reading a verdict](./reading-a-verdict.md).

## What to do next

That is the whole loop. Everything else in this manual is what you do once it
works:

- The goal is what decides whether a run is worth anything —
  [Writing a goal](./writing-goals.md) is the shortest page here and the one
  most worth reading.
- [Save the test](./saved-tests.md) so it can run again without being retyped.
- [Group your tests](./organizing.md) once there are more than a handful.
- [Schedule them](./schedules.md), or [trigger them from CI](./ci.md).
