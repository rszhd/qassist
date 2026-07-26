# BUG-002: `POST /api/tests` silently drops `project` / `module` slug keys

**Status:** 🐛 Open
**Reported:** 2026-07-26 (found while closing US-008)
**Area:** server (`server/src/routes/tests.js`)

## Symptom

A caller creating a test with `{"project": "checkout", "module": "auth"}` gets
a **201** and a test filed **ungrouped**. Nothing in the response says the
grouping was ignored.

## Root cause

`resolveGrouping` reads `project_id` and `module_id` only, and requires each to
be a uuid. Any other key name is not looked at, so the unrecognised
`project` / `module` fall through to the default "leave grouping alone" path
and the insert stores NULL for both.

## Why it is worth fixing

It contradicts the convention stated in `CLAUDE.md` — *path params take a slug
or a uuid* — at the one endpoint where a caller is most likely to be writing
by hand or from CI, since a slug is the only identifier a script has without
first querying for uuids.

## Fix, when it is picked up

Either accept slugs (resolve `project` / `module` against the caller's own
projects and modules, keeping US-023 decision 4's rule that a module derives
its project) or reject the unknown keys with a 400. Silently succeeding while
discarding what was asked for is the part that must go.
