# Reading a verdict

A finished run gives you five things: a status, a rationale, the steps it took,
a recording, and the evidence the page produced while it ran. They answer
different questions and it is worth knowing which is which.

## The status

| Status | What it means |
|---|---|
| **queued** | Waiting for a browser slot. The instance runs a fixed number of sessions at once; you are told your position. |
| **running** | In flight. |
| **passed** | The judge read the goal and the run, and says the goal was met. |
| **failed** | The judge says it was not. |
| **completed** | The agent finished without producing a verdict at all. |
| **error** | The run broke — the browser died, the key was rejected, the memory ceiling was hit. |
| **stopped** | Somebody pressed Stop. (`cancelled` in the API.) |

**`completed` is the one to look at twice.** It is not a soft pass. It means the
run ended without answering, which is usually a goal the judge could not check
against — see [Writing a goal](./writing-goals.md). Treat it as a failure
everywhere it matters, and [CI does exactly that](./ci.md).

**`stopped` verified nothing.** A run only reaches it because a person ended it
by hand, so it is not a verdict about your app either way.

## The rationale

Under the status, in prose: what the judge saw and why it decided as it did.
This is where a `failed` becomes actionable — it usually names the thing that
was missing ("the cart still showed 0 items after the click"), which tells you
whether your app is broken or your goal was.

Read it before you re-run. A goal that fails for the same stated reason twice is
not flaky.

## The steps

Every step the agent took, in order: what it was looking at, what it decided,
and what it did. Two uses:

- **Where did it go wrong?** Scrolling to the last step usually answers it in
  one look.
- **Is it wasting steps?** Ten steps to dismiss a cookie dialog and find the
  login form is ten steps of model spend on every run of this test, forever.
  That is what a [preamble](./organizing.md#a-preamble-before-the-first-step) and
  a [saved session](./saved-sessions.md) are for.

A run that used a [preamble](./organizing.md#a-preamble-before-the-first-step)
records it as step 0, so the steps the run is charged for still start at 1.

## The recording

The whole session as an mp4, on the run's page. It is the fastest way to answer
"what did it actually see", especially for a failure that the step list makes
sound reasonable.

Recordings are kept for a while and then swept — a week by default on a
self-hosted instance. **The verdict, the timings and the step count are kept
forever**; it is only the recording and the PDF that have a deadline. A run past
that point simply stops offering them.

## The evidence: what the page itself reported

A verdict says the goal was not reached. The diagnostics say what broke. Every
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

This is very often where the real answer is. A goal that failed at step 4 with a
`500` on `/api/order` at step 4 is not a testing problem.

::: tip Secrets never appear here
Everything captured is scrubbed of the run's [secret
variables](./variables.md) before it leaves the agent, so nothing here — and
nothing in the report or the notification mail — carries a password you stored.
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
before the goal ever got a chance, and both say so on the run rather than
blaming the goal:

- **`session_expired`** — the [saved session](./saved-sessions.md) this test
  starts from is no longer signed in. Checked before the first model step, so it
  costs nothing and does not wander into your login page.
- **`navigation_blocked`** — the run tried to go somewhere [the fence does not
  allow](./navigation-fence.md), including via a redirect mid-run.

## The PDF report

Where the instance renders one, a finished run offers **Download PDF report**:
the verdict, the stats, the summary, the step list with screenshots, the
diagnostics, and a link back to the recording. It is the artifact to attach to a
ticket, and it is what an [email notification](./notifications.md) carries.

Report rendering is an instance setting and is **off by default** on a fresh
self-hosted install while the renderer is being reworked. Nothing else depends
on it — the step list and the diagnostics come from elsewhere and are there
either way.

## Finding a run again

**History** lists every run, newest first, with its test, its grouping and its
verdict. Filter it by test, by project or module, by status, by date, and by
what started it — a human, a [schedule](./schedules.md), or [CI](./ci.md).

Every run also has a page of its own at `/runs/<id>` on your instance. That URL
is stable and shareable with anyone who can reach the instance, which is what
makes it worth pasting into a ticket rather than a screenshot.
