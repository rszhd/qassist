# Saving a test

An ad-hoc run is kept in History, but its definition is not reusable. A **saved
test** gives that URL and those instructions a name so you can run it again,
group it, schedule it, or trigger it from a pipeline.

## Making one

**New test** in the Tests list. What it holds:

| Field | |
|---|---|
| **Name** | What it is called in the list, in History, and in a failing CI log. Make it the thing being checked — `checkout with a saved card`, not `test 4`. |
| **Start URL** | Where the browser opens. Overridable per run. |
| **Instructions** | A sentence, a list of steps, or a pasted ticket — [Writing instructions](./writing-instructions.md). |
| **Project** and **Module** | Optional, and hidden until you have a project. [Organizing](./organizing.md). |
| **Start signed in** | Optional. A [saved session](./saved-sessions.md) from the same project. |
| **Variables** | Optional. Named values the instructions and the Start URL can reference — [Variables and secrets](./variables.md). |

Only the name, the URL and the instructions are required. A test that is nothing
but those three is a perfectly good test.

## Running one

Run it from the Tests list and it behaves exactly like an ad-hoc run: same live
view, same verdict. The difference is attribution. History can collect this
test's runs so you can tell whether a failure is new or recurring.

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
rewritten**: a history row keeps the instructions and the URL it actually ran
with, copied at the moment it was enqueued. So a run from last Tuesday still
tells you what was asked of it last Tuesday, even after the test has been
rewritten twice.

## Deleting one

Deleting a test does not delete its history. Its runs keep their verdicts,
timings, and step counts. They can no longer be filtered through the deleted
test or its grouping because that relationship is gone.

Deleting a **module** or a **project** never deletes tests either: they fall back
to Ungrouped. The one thing a project takes with it is its suites.

## Where they live

The Tests list sits beside the Run view. With no projects it is a flat list; a
search box appears once the list is long enough to need one. Once you have
projects, the same list gains a project selector, plus **Ungrouped** for tests
you have not filed.

That progression is the design: nothing about grouping appears before you have
made a group. If you only ever want a dozen tests in one list, QAssist never
asks you for more.
