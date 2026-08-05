# When a run goes wrong

The failures people actually hit, and what each one means.

## The run was refused before it started

**"no OpenAI key: add yours in Settings"** — no key is stored. Every run is
funded by the key you store, and the instance holds none of its own. Settings →
OpenAI key.

**A variable was required and had no value.** A [variable](./variables.md) the
goal references, with no default and no override, is a hole in the goal. The
error names it. Give it a default on the test, or pass it with the run.

**The session has never been captured.** A test that opts into a [saved
session](./saved-sessions.md) which is still empty is refused rather than run
signed out — a test that quietly runs signed out passes nothing and fails
everything. Run its login test once, or fill it with the extension.

**The URL is blocked.** See [Where a run may go](./navigation-fence.md); the
error carries the reason.

**A subscription is needed** (on an instance that bills). Reading everything you
already have stays open — cancelling is never a data-loss event.

## The run passed and should not have

Almost always the goal. A goal that describes *clicking* is true the moment the
click happens, whatever it produced. [Writing a goal](./writing-goals.md) is the
fix, and it is one page.

The second cause is a [one-shot identity](./saved-sessions.md#social-login): a
signup test whose account already exists lands on "welcome back" and passes,
while no longer testing what its name says.

## The run ended `completed` — neither pass nor fail

The agent finished and the judge produced no verdict. Treat it as a failure. It
usually means the goal gave the judge nothing checkable, and occasionally that
the run ran out of steps before reaching the point the goal is about.

## The site works in your browser and fails from QAssist

**Some sites block datacenter IP addresses.** Reddit and Cloudflare-heavy pages
are the usual ones. This is expected rather than a bug: your laptop's address
looks residential and a server's does not.

When the site is *yours*, allowlist the instance's address at your WAF or CDN.
When it is not, there is no setting that fixes it.

## The run wandered and burned steps

Read the [step list](./reading-a-verdict.md#the-steps) and look at what the first
five steps were spent on. Two very common answers:

- **A cookie dialog.** Dismiss it once for the whole project with a
  [preamble](./organizing.md#a-preamble-before-the-first-step), at no token cost.
- **Logging in.** Capture the signed-in state once and start past it —
  [Behind your login](./saved-sessions.md).

Both are settings, not goal rewrites.

## The run failed and the goal looks right

Look at the [evidence](./reading-a-verdict.md#the-evidence-what-the-page-itself-reported)
before rewriting anything. A `500` on the request the button fired, or an
uncaught exception at the step it stopped on, is not a testing problem — it is
the answer.

## The run says `session_expired`

The [saved session](./saved-sessions.md) is no longer signed in. If it is filled
by a login test, run that test — a passing run refreshes it. Scheduling that
test nightly stops this recurring.

## A schedule looks healthy and is testing nothing

Its target was emptied. The next slot keeps advancing while no run actually
starts. The schedule row carries both tells — see
[Schedules](./schedules.md#the-failure-this-page-exists-to-warn-you-about).

## Runs are queuing and not starting

An instance runs a fixed number of browser sessions at once and queues the rest,
telling each its position. A batch of twelve on a two-session instance is six
run-lengths of wall clock, which is arithmetic rather than a fault.

If you run the instance, that cap is [a setting sized to
RAM](./self-hosting.md#sizing-it-for-your-box).

::: warning The queue is not durable
A restart marks everything still waiting as errored. Drain before restarting if
that matters.
:::

## The recording and the report are gone

Per-run artifacts are swept after a retention window — a week by default on a
self-hosted instance. **The verdict, the timings and the step count are kept
forever.** A run past that point simply stops offering the recording and the
PDF.

## There is no Download PDF button at all

Report rendering is off by default on a fresh self-hosted install, while the
renderer is being reworked. It is [one setting](./settings.md). Nothing else
depends on it — the step list and the diagnostics are there either way.

## Chromium crashes on heavy pages

It needs shared memory. Both shipped compose files already set `shm_size: 1gb`;
if you wrote your own, add it.
