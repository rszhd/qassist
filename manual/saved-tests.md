# Saving a test

A run typed into the Run view happens once and is gone. A **saved test** is the
same goal given a name, so it can be run again, grouped, scheduled and triggered
from a pipeline — everything else in this manual is built on it.

## Making one

**New test** in the Tests list. What it holds:

| Field | |
|---|---|
| **Name** | What it is called in the list, in History, and in a failing CI log. Make it the thing being checked — `checkout with a saved card`, not `test 4`. |
| **Start URL** | Where the browser opens. Overridable per run. |
| **Instructions** | The goal. A sentence, a list of steps, or a pasted ticket — [Writing a goal](./writing-goals.md). |
| **Project** and **Module** | Optional, and hidden until you have a project. [Organizing](./organizing.md). |
| **Start signed in** | Optional. A [saved session](./saved-sessions.md) from the same project. |
| **Variables** | Optional. Named values the goal and the URL can reference — [Variables and secrets](./variables.md). |

Only the name, the URL and the instructions are required. A test that is nothing
but those three is a perfectly good test.

## Running one

Click it and press **Run**, and it goes exactly as an ad-hoc run does — same
live view, same verdict. The difference is what happens afterwards: the run is
attributed to the test, so History can show you this test's last twenty runs and
whether the failure is new.

**The start URL is overridable at run time.** This is what makes one saved test
cover every environment: the test is saved against production, and CI runs the
same test against the preview deploy it just built by passing that URL. It is a
full replacement, not a prefix — a test saved against
`https://example.com/login` and run against `https://preview-abc.example.com`
starts at that preview's *root*.

::: tip Write CI-bound tests to navigate from the root
Because the override replaces the whole URL, a test you intend to run against
preview deploys should say "go to the login page, then …" rather than being
saved with `/login` in its URL. That is what you want anyway — the navigation is
part of what is being tested.
:::

## Editing one

Edit a test and the change applies from the next run. **Past runs are not
rewritten**: a history row keeps the goal and the URL it actually ran with,
copied at the moment it was enqueued. So a run from last Tuesday still tells you
what was asked of it last Tuesday, even after the test has been rewritten twice.

## Deleting one

Deleting a test does not delete its history. The runs keep their verdicts,
timings and step counts — what they lose is the ability to be filtered by
project or module, since that link went with the test.

Deleting a **module** or a **project** never deletes tests either: they fall back
to Ungrouped. The one thing a project takes with it is its suites.

## Where they live

The Tests list sits beside the Run view. With no projects it is a flat list with
a filter box — which is the whole UI, and is deliberately all there is until you
need more. Once you have projects, the same list gains a project selector, plus
**Ungrouped** for the tests you never filed.

That progression is the design: nothing about grouping appears before you have
made a group. If you only ever want a dozen tests in one list, QAssist never
asks you for more.
