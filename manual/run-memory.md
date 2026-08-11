# What a test remembers

A saved test keeps a small **Run memory** of what its passing runs learned. On
the next run, QAssist gives those lessons to the agent as advice from an earlier
run. This can keep a repeated test from taking the same wrong turn every time.

There is nothing to enable or prepare. A saved test's passing run can teach the
next one automatically when its Activity contains a useful lesson. Ad-hoc runs
have no saved test to attach memory to, so they always run cold.

## What it learns

Memory is a QA notebook, not a recording of clicks. It can hold:

- **What worked** — the approach that reached the state under test.
- **Avoid next time** — an unhelpful approach, why it was wrong, and what worked
  instead.
- **Orientation** — a stable fact such as where the successful flow ended.

A passing run may add lessons grounded in its Activity. A failed, errored,
completed, or stopped run does not teach the notebook because it did not prove
that its route was sound.

Memory contains descriptions, not selectors, element numbers, copied page
content, credentials, or a replayable action list. The agent still reads the
current page and chooses every action again. It does not skip part of the test
because an earlier run passed it, and memory never changes the verdict the test
is judged against.

## Reading and correcting it

Open **Edit test**. Once the test has learned something, a collapsed **Run
memory** panel appears below its fields. It shows exactly what the next run will
receive. Each lesson also says when it was learned, links to the run that found
it, and says when that run was [guided by a person](./steering-a-run.md).

If one lesson is wrong, use **Remove this lesson** beside it. Use **Clear** to
discard everything the test learned. Neither action changes run history. The
next passing run starts cold and can learn the flow again.

The panel is absent until there is something to show. There is no memory field
to fill in and no per-test switch.

## When a run starts cold

A saved test runs without earlier advice only when:

- it has never learned a lesson;
- you cleared its memory; or
- you removed its last lesson.

The run's detail shows **Memory: Ran cold** or **Memory: Started with what
earlier runs learned**, so you do not have to infer which happened.

A failure does not erase memory. Neither does changing the model, refreshing a
saved session, or editing the test. Those changes do not reliably tell QAssist
whether the application flow changed.

When you save an edit that changes the **Start URL** or **Instructions**, QAssist
therefore asks whether to clear the existing lessons. Keeping them is the
default. Clear them when the edit points at a different application or makes the
old route irrelevant; keep them for wording fixes and changes that leave the
flow intact.

## Memory and sensitive values

Lessons are scrubbed before storage and checked again before a later run reads
them. Secret-variable values, fetched confirmation codes, selectors, raw page
excerpts, and entered values are not valid memory content.

The notebook is deliberately small and disposable. Run history remains the
record of what happened; memory is only advice for what to try next.
