# Files a run can upload

A goal like "upload cv.pdf and submit the application" needs that file to
exist. A **project** holds reusable files for its tests.

## Adding one

Open the project, go to **Files**, and upload. The name you give it is the name
your goal uses:

```
Goal  Fill in the application form and upload cv.pdf, then submit
```

The agent is handed the paths of its project's files and matches by filename.
There is nothing to configure per test.

## What is allowed

- **Filenames** start with a letter or a digit, and contain only letters,
  digits, spaces, dots, dashes and underscores — in any alphabet, `简历.pdf`
  is fine. They must not end with a dot or a space, and must fit in 255 bytes.
  Anything else is refused.
- **A duplicate name is refused**, not overwritten. Delete the old one first;
  silently replacing a file would change what a saved test uploads with nothing
  in the history to say so.
- **Two size caps**: one per file, one per project. Both are [instance
  settings](./settings.md), and going over either is refused at upload time.

## A run may only touch its own project's files

This is a security boundary, especially on a shared instance.

The agent's ability to read a file and its ability to upload one are gated on
the same list — the fixtures of the project the run's **saved test** belongs to.
The project is read from the test's row and never from the request, so:

- An **ad-hoc run** from the Run view has no test and therefore no project, and
  may attach nothing at all.
- A run in project A can never reach project B's files, however the goal is
  worded.

Without that list, an agent that could be argued into reading a file would be a
file-read primitive pointed at the container. With it, the worst case is a file
you uploaded yourself.

## They outlive your runs

Files live outside the per-run artifact directory, so the [retention
sweep](./reading-a-verdict.md#the-recording) that removes recordings and reports
never removes them. They are deleted when you delete them, or when you delete
their project.
