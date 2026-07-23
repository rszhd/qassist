# US-030 — A run has its own page

**As a** user, **I want** every run to live at its own URL, **so that** I can open the one a notification is about, and send it to someone.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1 — US-012's email is the thing that needs it)
- **Estimate:** ~half a day
- **Depends on:** US-011 (history + `GET /api/runs/:id`), US-026 (steps read path)

## Why

Every run already has an id, a stored row, a step list and a PDF — and no
address. The Run view holds whichever run this browser tab started; History
shows a past run in a side panel that exists only while that list is on screen.
So there is nothing to link to: US-012's failure email currently says "QAssist:
https://…  (run 1a2b3c4d)" and leaves the reader to find it, and a CI job that
knows a run id has the same problem.

## Details

- `/runs/<id>` renders one run: verdict, goal, start URL, timings, the step
  activity US-026 already reads back, the recording, and the report.
- Reuses `RunDetail.jsx` rather than growing a second renderer — History's
  panel and this page should not drift.
- A **live** run opened this way should attach to the WebSocket the way the Run
  view does, so a link sent mid-run keeps working as the run finishes.
- The server already answers a non-`/api` path with `index.html` (SPA
  fallback), so no route work is needed there; the frontend has no router
  today, and App.jsx picks its view from state.
- US-012's `compose()` links `/runs/<id>` once this exists.

## Open questions

- **Router or a parsed path?** The app has four views and no router. One
  `URL`-parsed path in `App.jsx` may be enough; a router is the answer only if
  History filters and the Projects selection want to be linkable too (they
  plausibly do — decide before writing).
- **What a tokenless visitor sees.** Auth is still one shared
  `WORKER_API_TOKEN` held in `localStorage`, so a colleague opening the link
  without it gets the token prompt — the attached PDF is what serves them until
  US-021. Worth deciding whether the page says that plainly rather than looking
  broken.

## Acceptance criteria

- [ ] `/runs/<id>` loads a finished run directly, in a fresh tab
- [ ] The same URL on a running run shows it live and updates to its verdict
- [ ] An unknown or pruned id explains itself instead of rendering an empty page
- [ ] History's detail panel and this page render from the same component
- [ ] US-012's email links to it
