# US-026 — Run activity in the History detail panel

**As a** user reviewing a past run, **I want** the step-by-step activity beside
its verdict, **so that** I can see *where* a run went wrong without opening the
PDF or re-running it.

- **Status:** 📋 Planned
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

## Decisions to make while implementing

- **`progress` events are not in the file** (`generateReport` keeps only
  `type === 'step'`), so a past run reads sparser than what you watched live.
  Either accept that, or widen the writer — one line, but it also grows every
  `report_data.json` and the PDF renderer reads the same file.
- **Pruned runs lose their steps** with the rest of `runs/<id>/`. The panel
  already has the "artifacts were removed on …" line for that case; the step
  list should fall under it rather than render an empty log.
- A run killed before `done`/`error` (process crash) may have no
  `report_data.json` at all — the empty state has to be honest about the
  difference between "no steps recorded" and "steps were pruned".

## Acceptance criteria

- [ ] `GET /api/runs/:id/steps` returns the step list for a finished run, for a
      run still in memory, and 404s when the artifacts are gone
- [ ] Selecting a run in History shows its steps in the detail panel; selecting
      another replaces them
- [ ] A pruned run explains itself instead of showing an empty list
- [ ] The Run view's live activity and History's list are the same component
- [ ] `cd server && npm test` covers the new endpoint (finished, in-memory,
      pruned); `npm run check` clean

## Later

US-020 puts step screenshots in the report and reads the same `steps[]`
entries (`screenshot_file`). Once it lands, a step in this list is the obvious
place to click through to its screenshot — do not build a second viewer for it
here.
