# Schedules

A schedule runs a test, module, suite, or whole project on a repeating slot. It
behaves like running that target by hand: one run per member test, subject to
the same concurrency cap.

## Making one

A schedule names **exactly one** target and one of three shapes:

| Shape | What you set | Example |
|---|---|---|
| **Hourly** | An interval of 1, 2, 3, 4, 6, 8 or 12 hours, and a minute | every 6 h at :15 |
| **Daily** | An hour and a minute | 02:30 |
| **Weekly** | A weekday, plus the hour and minute | Tuesday 09:00 |

Plus a **timezone**, which defaults to the instance's. Times mean wall-clock
time there, so a nightly 02:30 stays at 02:30 across a daylight-saving change
rather than drifting to 01:30 for half the year.

**Hourly slots are anchored to local midnight.** "Every 6 hours at :15" means
00:15, 06:15, 12:15, 18:15 — not six hours after whenever you happened to save
it.

## What to schedule

A **suite** is the usual answer: a curated set of tests, run nightly, that tells
you in the morning whether anything drifted. A **module** works when the thing
you want checked maps to one part of the app.

A **whole project** is every test there is. That is a legitimate nightly and a
bad hourly.

::: tip A schedule is not a deploy gate
Gating a deploy is [CI](./ci.md) — it needs to run against the URL that deploy
just produced and block the pipeline on the answer. A schedule runs against the
saved URLs on a clock and blocks nothing.
:::

## Secrets

A schedule has nobody to ask, so it uses the value stored on the test. Saving a
schedule whose target needs a secret it has not got is **refused**, naming the
test and the variable — see [Variables and secrets](./variables.md#schedules-and-secrets).

## What it will and will not do

- **A missed slot is not replayed.** If the instance was down for six hours, the
  slots that passed are gone. Nothing catches up in a burst on restart.
- **A test already running is skipped for that slot**, while its siblings in the
  same suite go ahead. A slow test cannot pile up copies of itself.
- **Deleting the target deletes its schedules.** They do not linger pointing at
  nothing.
- **Pausing is a switch**, not a delete. A paused schedule keeps its shape and
  its history; re-enabling it resumes from the next slot.

## Reading a schedule's history

Each schedule shows its recent slots, newest first, with one mark per firing.
Two details matter:

**A slot is one firing, not one run.** A suite schedule starts one run per
member, and they are a single entry whose result is the worst of them. Green
means every member passed. A slot still in flight reads as running or queued —
never as passed.

**A slot that started nothing at all is absent, not marked.** An empty target,
every member already running, a lapsed subscription: none of those write a run,
so there is nothing for the list to show.

## The failure this page exists to warn you about

A schedule can keep consuming slots while testing nothing. This happens when
its target is emptied — for example, the last test moves out of a module or all
suite members are deleted — while the schedule remains enabled.

Two labels on the row catch it:

- **`no tests`** means the target is empty now.
- **A `not running` flag**, set when a slot has certainly come round
  since the last time a run actually started. It is not raised on a schedule
  made this afternoon that is not due until 02:00, and never on a disabled one.

The underlying tell, if you prefer to read it yourself: the *next* slot keeps
advancing while the *last actual run* stands still. A schedule in that state has
stopped testing anything and has not said so.
