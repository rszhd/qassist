# Projects, modules and suites

Three ways to group tests, and they are not alternatives to each other — they
answer different questions. None of them exist until you make one, so a small
set of tests can ignore this page entirely.

## The shapes

**A project** is the outer box: usually one application or product boundary. It
owns everything else on this page, along with settings shared by its tests —
who gets emailed, where runs may navigate, which files they may upload, and
which signed-in sessions they may use.

**A module** is a part of that app: `auth`, `checkout`, `search`. A test sits in
**at most one** module. Selecting a module also fixes the test's project; a test
may belong to a project without belonging to any module.

**A suite** is the cross-cutting alternative: an arbitrary selection of tests
inside one project, and a test can be in as many as you like. `smoke`,
`nightly`, `pre-release`.

The difference is worth stating plainly, because picking the wrong one is the
usual mistake:

> A module is **where a test lives**. A suite is **why you would run it now**.

`checkout` is a module — a test belongs to it or it doesn't. `smoke` is a
suite — it is a reason to run twelve tests that live in five different modules.

## All four are runnable

A test, a module, a suite and a whole project all run in one action, and all
behave the same way: **one run per member test**, queued behind the instance's
concurrency cap like any other run. A ten-test module on a two-session instance
takes five run-lengths of wall clock.

This is what makes the grouping worth having. A module is the set of tests that
covers a change, so it is what a [pipeline gates on](./ci.md). A suite is a
curated set, so it is what a [nightly schedule](./schedules.md) fires.

::: tip A whole project is a nightly, not a per-deploy gate
Running a project is every test there is — minutes of browser time and model
spend on every push. Point CI at a module or a suite.
:::

## What a project carries

Open a project and the sections are the things it owns:

- **Modules** — its parts, each with its test count.
- **Suites** — its selections. Suites are scoped to one project and their
  members must be in it too.
- **Sessions** — saved signed-in browser states its tests may start from.
  [Behind your login](./saved-sessions.md).
- **Files** — the fixtures its tests may upload. [Files a run can
  upload](./files.md).

Plus settings that apply to everything in it: [where its runs may
navigate](./navigation-fence.md), [who hears about
them](./notifications.md), and the preamble below.

## A preamble before the first step

A project can carry **initial actions** — a short list of deterministic browser
actions run before the agent's first model step, at no token cost.

The case it exists for: a cookie dialog. Dismissing one is two wasted steps on
every run in the project, forever, and it is not part of what any of those tests
are checking. Set it once on the project and it stops being anyone's problem:

```
send_keys: Escape
wait: 2 seconds
```

Only four actions are available: `navigate`, `wait`, `send_keys`, and `scroll`.
Everything else the agent can do needs to know which element it is acting on,
and no element has been inspected yet when the preamble runs.

A `navigate` in a preamble is checked against the same [navigation
fence](./navigation-fence.md) a start URL is, at the moment you save it rather
than at run time.

The preamble is recorded as **step 0**, so the steps a run is charged for still
start at 1.

## Renaming things

Projects and modules carry a slug, taken from the name when they are created,
and paths accept either the slug or the id. A pipeline pointed at
`/api/projects/checkout/modules/auth/run` reads as what it runs, which is the
reason to use the slug.

**Renaming a project or a module does not move its slug.** The slug changes only
when you change it deliberately — a rename that silently broke a CI config would
be the worse failure. So renaming `Checkout` to `Checkout (v2)` costs nothing,
and if you do want the URL to follow, change the slug in the same edit and fix
the pipeline with it.

Suites do not have slugs, so a suite target carries its ID. In the suite's row,
choose **Run from CI** to copy a command containing the correct endpoint.
