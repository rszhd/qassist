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

## 2. Add your OpenAI key (unless you are in the demo)

The demo replays prepared runs, so it needs no key. On a hosted account, follow
the onboarding checklist. On your own instance, open **Settings**, find
**OpenAI key**, and paste yours.

For a real run, this is required. Every run is funded by the key its owner
stores, on every tier. QAssist holds no shared model key, so one user cannot
spend another user's tokens. Until your key is stored, a run is refused with
*no OpenAI key: add yours in Settings*.

The key is stored encrypted and never shown again. QAssist tells you whether a
key is set, but never returns the key itself.

::: tip Hosted accounts include a subscription step
On an instance that bills, the onboarding checklist asks you to subscribe after
you add the key. The subscription pays for browser capacity; model usage still
goes to your own OpenAI account.
:::

## 3. Type a start URL and instructions

In the **Run** view, choose **New run**. The dialog asks for two things:

| Field | What goes in it |
|---|---|
| **Start URL** | Where the browser opens. `https://example.com` |
| **Instructions** | What the agent should do and what should be true when it is done, in plain English. |

For a first run, pick something with an unambiguous answer:

```
Start URL     https://example.com
Instructions Confirm the page shows the heading "Example Domain"
```

Choose **Run test**.

## 4. Watch it

The browser session appears within a few seconds and streams while the agent
works. Beside it, the Activity list updates with the agent's current step.

You can leave. The run does not depend on you watching it — closing the tab does
not stop it, and reopening the run picks the stream back up. QAssist sends live
frames only while someone is watching. When recording is enabled, the instance
still captures the frames needed for the recording.

If you decide it is going nowhere, **Stop run** ends it. A stopped run finishes
what it can — including its recording and report — and ends as `cancelled`.

## 5. Read the verdict

When it finishes you get a verdict, a written summary, and the recorded
activity. A recording and PDF are also available when the instance enables
them. [Reading a verdict](./reading-a-verdict.md) explains what each part means,
including a `completed` run that is neither a pass nor a fail.

## What to do next

That is the whole loop. Everything else in this manual is what you do once it
works:

- The instructions decide whether a run is worth anything — [Writing
  instructions](./writing-instructions.md) is the shortest page here and the one most
  worth reading.
- [Save the test](./saved-tests.md) so it can run again without being retyped.
- [Group your tests](./organizing.md) once there are more than a handful.
- [Schedule them](./schedules.md), or [trigger them from CI](./ci.md).
