# US-030 — A run has its own page

**As a** user, **I want** every run to live at its own URL, **so that** I can open the one a notification is about, and send it to someone.

- **Status:** ✅ Done (2026-07-23)
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

## Decisions

1. **react-router, not a parsed path** (2026-07-23, the user's call on the open
   question below). One `URL` parse in App.jsx would have covered `/runs/<id>`
   alone, but the four existing views want addresses for the same reason a run
   does, and History's filters and the Projects selection are the next things
   to become linkable. So all five are routes: `/`, `/history`, `/schedules`,
   `/projects`, `/runs/<id>`, and an unknown path redirects to `/` rather than
   rendering an empty shell.
2. **`RunView` stays outside `<Routes>`.** It is hidden, not unmounted, exactly
   as before — the live WebSocket and the finished run's result die with the
   component. This is the one thing the router must not be allowed to "clean
   up", and it is why the router is used as an address for the shell rather
   than as a switch over all five views.
3. **`GET /api/runs/:id` answers in the list shape**, so `RunDetail` renders
   from it with no translation and the History panel and the page cannot drift.
   The camelCase keys (`runId`, `testId`, `result`, `reportStatus`,
   `hasRecording`) are kept on top of those columns because `docs/ci.md` polls
   this endpoint — the shape a documented CI script reads must not move under
   it. A run still in the relay overlays its live `status`/`result` on the row,
   and `liveRow()` covers the two moments there is no row to read: no control
   plane at all, and the gap before the fire-and-forget insert lands.
4. **The page shows the live frames.** Subscribing is what turns the screencast
   on (US-002 only captures while a viewer is attached), so a page that
   attached and dropped the frames would cost the run's Chromium the encode
   anyway. It repeats the browser chrome and nothing else of the Run view's
   stage — the queued copy, the replay player and the verdict card are that
   view's own state.
5. **A tokenless visitor is told so.** Auth is still one shared
   `WORKER_API_TOKEN`, so a colleague opening the link without it gets the same
   "API token needed" banner the Run view uses, saying plainly that until then
   the attached report is the whole story. Revisit with US-021.
6. **History links out to the page**, via a `permalink` prop on `RunDetail` —
   otherwise the address exists and nothing in the UI ever shows it. The page
   itself has no reason to link to itself, so the prop is History's alone.

## Open questions

- ~~**Router or a parsed path?**~~ Settled — decision 1.
- ~~**What a tokenless visitor sees.**~~ Settled — decision 5.

## Acceptance criteria

- [x] `/runs/<id>` loads a finished run directly, in a fresh tab
- [x] The same URL on a running run shows it live and updates to its verdict
- [x] An unknown or pruned id explains itself instead of rendering an empty page
- [x] History's detail panel and this page render from the same component
- [x] US-012's email links to it

## Results

`react-router-dom` is the frontend's third runtime dependency (~1.5 kB gzipped
of the bundle's 80 kB). `Button` and `IconButton` grew an `as` prop so a link
that looks like a button is still the shared primitive rather than a
hand-styled anchor.

Left for later: the Run view's stage is still the only place a run can be
*watched* in full (queued copy, replay player, verdict card). Extracting it so
the permalink offers the same thing is a refactor of that view, not of this
story; the page shows the live frame and the streaming step list, which is what
a link sent mid-run needs to stay honest.
