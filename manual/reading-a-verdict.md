# Reading a verdict

A finished run can give you five things: a status, a summary, its activity, a
recording, and diagnostics from the page. They answer different questions.

## The status

| Status | What it means |
|---|---|
| **queued** | Waiting for a browser slot. The instance runs a fixed number of sessions at once; you are told your position. |
| **running** | In flight. |
| **passed** | The judge read the instructions and the run, and says the requested outcome was met. |
| **failed** | The judge says it was not. |
| **completed** | The agent finished without producing a verdict at all. |
| **error** | The run broke — the browser died, the key was rejected, the memory ceiling was hit. |
| **stopped** | Somebody pressed Stop. (`cancelled` in the API.) |

**`completed` is the one to look at twice.** It is not a soft pass. It means the
run ended without answering, which usually means the judge could not check the
instructions — see [Writing instructions](./writing-instructions.md). Treat it as a
failure everywhere it matters, and [CI does exactly that](./ci.md).

**`stopped` verified nothing.** A run only reaches it because a person ended it
by hand, so it is not a verdict about your app either way.

**An assisted run verified less.** If somebody told the run what to do while it
was going, the status alone does not say so — the activity list and the PDF
report both do, and the report says it on its cover. A pass that needed a person
to point at the button did not show that a user could have found it. See
[Steering a live run](./steering-a-run.md).

## The summary

Under the status, **Summary** describes what happened and why the run reached
its verdict. This is where a `failed` becomes actionable: it often names the
missing outcome ("the cart still showed 0 items after the click"), helping you
separate an application failure from poorly scoped instructions.

Read it before you re-run. A test that fails for the same stated reason twice is
not flaky.

## The steps

The Activity list records what the agent worked on at each step. In the app,
the newest step appears first so a live run stays easy to follow. It has two
main uses:

- **Where did it go wrong?** The newest few steps usually answer that in one
  look.
- **Is it wasting steps?** Ten steps to dismiss a cookie dialog and find the
  login form is ten steps of model spend on every run of this test, forever.
  That is what a [preamble](./organizing.md#a-preamble-before-the-first-step) and
  a [saved session](./saved-sessions.md) are for.

A run that used a [preamble](./organizing.md#a-preamble-before-the-first-step)
records it as step 0, so the steps the run is charged for still start at 1.

## The recording

When recording is enabled, the run page contains the whole session as an MP4.
It is the fastest way to answer "what did it actually see", especially when the
Activity list makes a failure sound reasonable.

**The recording is shorter than the run, and this is correct.** Only the frames
showing a page change are recorded, so the time a run spends waiting — for a
slow login, an API call, a redirect — costs the recording almost nothing. A run
of 3:41 can replay in 48 seconds. Two clocks follow from that: the run's
Duration is wall clock, and the player's own control bar is not. Nothing was
cut.

Click an Activity step, or the step heading above a diagnostic, to move the
player to that moment. This is the reliable way across the two clocks — reading
a step's position off the run's Duration and dragging the scrub bar there lands
somewhere else.

Per-run artifacts are kept for a while and then swept — a week by default on a
self-hosted instance. This removes the recording, PDF, HAR, screenshots, and
stored Activity details. **The verdict, summary, timings, and step count remain
in History.**

## The evidence: what the page itself reported

A verdict says the requested outcome was not reached. The diagnostics say what broke. Every
run captures, stamped with the step it happened during:

- **Failed requests** — anything that came back 400 or worse, plus the ones that
  never came back at all. A request with no status is a transport failure: a
  CORS rejection, a DNS failure, a connection refused. None of those are visible
  in a screenshot.
- **Console errors and warnings** — what your app logged.
- **Uncaught exceptions** — what it threw.

Identical findings are counted rather than repeated, and the list is a summary
rather than an archive: at most five distinct findings per kind per step. A page
emitting thousands of console lines cannot drown the run.

This is very often where the real answer is. A test that failed at step 4 with a
`500` on `/api/order` at step 4 does not have an instruction problem.

::: tip Structured evidence is scrubbed
QAssist scrubs secret-variable values from the instructions, Activity, diagnostics,
report text, and notification email before they leave the agent. Images are
pixels rather than text, so do not design a test that deliberately renders a
secret visibly on the page.
:::

### When the summary is not enough

A single run can be asked for a complete HAR instead, and then downloaded from
the run. Headers and bodies are not recorded, so no `Authorization` or `Cookie`
value reaches the file.

::: warning The HAR is the one artifact redaction does not reach
Chromium writes it, not QAssist, so a secret that appears in a **query string**
appears in the file verbatim. That is why it is off by default, and why it is a
download rather than something the report embeds or an email attaches.
:::

## Two failures that name themselves

Most failures are a verdict. Two are the run telling you the setup was wrong
before the instructions ever got a chance, and both say so on the run rather
than blaming the instructions:

- **`session_expired`** — the [saved session](./saved-sessions.md) this test
  starts from is no longer signed in. Checked before the first model step, so it
  costs nothing and does not wander into your login page.
- **`navigation_blocked`** — the run tried to go somewhere [the fence does not
  allow](./navigation-fence.md), including via a redirect mid-run.

## The PDF report

Where the instance renders one, a finished run offers **PDF report**: the
verdict, stats, summary, step list with screenshots, and diagnostics. When the
instance has a public base URL and a recording, the PDF links back to it. The
PDF is the artifact to attach to a ticket, and it is what an [email
notification](./notifications.md) carries.

Report rendering is an instance setting and is **off by default** on a fresh
self-hosted install while the renderer is being reworked. Nothing else depends
on it — the step list and the diagnostics come from elsewhere and are there
either way.

## Finding a run again

**History** lists every run, newest first, with its test, grouping, and verdict.
Filter it by test, project, status, date, and what started it — a human, a
[schedule](./schedules.md), or [CI](./ci.md).

Every run also has a page of its own at `/runs/<id>` on your instance. The URL
is stable and can be shared with someone who has access to that run, which makes
it more useful in a ticket than a screenshot.
