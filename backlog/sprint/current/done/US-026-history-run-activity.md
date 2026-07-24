# US-026 — Run activity in the History detail panel

**As a** user reviewing a past run, **I want** the step-by-step activity beside
its verdict, **so that** I can see *where* a run went wrong without opening the
PDF or re-running it.

- **Status:** ✅ Done (2026-07-23)
- **Priority:** P2 (History ships without it; a failed run is the case where
  "what did it actually do?" is the only question worth asking)
- **Estimate:** ~half a day
- **Depends on:** US-011 (History view + detail panel)

## Background

The Run view streams `step` events into its activity panel while a run is
happening, and they are gone the moment the run leaves the in-memory relay
(`RUN_TTL_MS`). History's detail panel therefore shows a verdict, three stats
and two artifact buttons — it can say a run failed at step 9 of 12, but not
what step 9 was trying to do.

The steps are already on disk. `generateReport()` in `server/src/runs.js`
writes `runs/<id>/report_data.json` for every finished run — on `done`, on
`error` and on a watchdog kill — and its `steps[]` array carries exactly what
the panel wants:

```json
"steps": [{ "step": 1, "elapsed": 4.2, "next_goal": "…", "evaluation": "…",
            "url": "https://…", "screenshot_file": "step_01.png" }]
```

So this is a read path over an existing artifact, not new persistence. **No
steps table** — that would duplicate the file and break the rule that the DB
holds metadata and verdicts while artifacts stay under `runs/<id>/`.

## Design

1. **`GET /api/runs/:id/steps`** in `routes/runs.js`, beside `/:id/recording`.
   In-memory run (still relaying, or opened from History mid-flight) answers
   from `run.events`; otherwise read `report_data.json` and return its
   `steps`. Missing file → 404, same as a pruned recording.
2. **Extract the activity list** from `RunView.jsx` — the `.log` / `.log-item`
   markup plus `stepText()` — into a component both views render, so the live
   log and the historical one can't drift into two different lists.
3. **`RunDetail.jsx`** fetches on selection change and renders it under
   `.detail-facts`, height-capped by `--scroll-cap` like the live log.
   `.hist-detail` is `--col-side` wide — the same width the activity panel
   already lives at, so nothing about the layout changes.

## Decisions taken while implementing

1. **`progress` events stay live-only.** The writer was not widened: the PDF's
   step section renders `Step {step}`, and a progress event has no step number
   to render — it would print "Step None" into every report that had one, in
   the section US-020 is about to rework. So a past run reads sparser than
   what you watched live, deliberately.
2. **One shaper, `stepsOf(run)` in `src/runs.js`**, used by `generateReport`
   and by the endpoint's in-memory branch. That is what makes the live answer
   and the on-disk answer the same shape rather than two shapes that agree
   today — the server-side counterpart to sharing the component.
3. **Pruned runs are not fetched at all.** `RunDetail` already knows
   `artifacts_deleted_at`; asking for a 404 to learn what the row already says
   is a wasted request, and the "artifacts were removed on …" notice is the
   honest explanation. A 404 on a run that was *not* pruned means no
   `report_data.json` was ever written (the process died first), and that gets
   its own empty state — "This run ended before its steps were written to
   disk."
4. **`RunDetail` is keyed by run id** in `HistoryView`. It holds fetch state
   now, and without the key React keeps the instance across a selection
   change, painting the previous run's steps under the new run's verdict for a
   frame. The key also stops a recording from auto-playing when you switch
   runs with the player open.
5. **`REPORT_DATA_FILENAME`** joined `RECORDING_FILENAME` in `config.js` once
   the filename was read in two places.
6. **The detail column widened to 440px**, against this story's own design
   note above. The plan assumed `--col-side` would do, because the activity
   panel lives at that width on Run — but there the log sits beside a browser
   frame and is glanceable, whereas in History it *is* the content. At 300px a
   step goal wrapped to four lines and the URL fact ellipsised. It is a
   literal rather than a token because it is used once, and the `--col-side`
   comment now says History's detail is deliberately not one of those columns.

## Acceptance criteria

- [x] `GET /api/runs/:id/steps` returns the step list for a finished run, for a
      run still in memory, and 404s when the artifacts are gone
- [x] Selecting a run in History shows its steps in the detail panel; selecting
      another replaces them
- [x] A pruned run explains itself instead of showing an empty list
- [x] The Run view's live activity and History's list are the same component
      (`Activity.jsx`, holding the `.log` markup and `stepText()`)
- [x] `cd server && npm test` covers the new endpoint (finished, in-memory,
      pruned); `npm run check` clean

## Results

Server: `stepsOf()` in `src/runs.js`, `GET /api/runs/:id/steps` in
`routes/runs.js` beside `/:id/recording`, `REPORT_DATA_FILENAME` in
`config.js`. Frontend: `Activity.jsx` extracted out of `RunView.jsx`, rendered
by both views; `RunDetail.jsx` fetches on mount and renders the list as a
direct child of `.run-detail`, so the card's own `--s3` gap spaces it and
`.log`'s `--scroll-cap` caps it — the list itself needed no new CSS. The only
rule that changed is `.history`'s grid, per decision 6.

39 server tests pass, `npm run check` clean, `npm run build` clean. Exercised
against the dev server's real history: runs with 1 and 4 steps returned their
lists, an unknown uuid and a non-uuid path both 404.

## Later

US-020 puts step screenshots in the report and reads the same `steps[]`
entries (`screenshot_file`). Once it lands, a step in this list is the obvious
place to click through to its screenshot — do not build a second viewer for it
here.
