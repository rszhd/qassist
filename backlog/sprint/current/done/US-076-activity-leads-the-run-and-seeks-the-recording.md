# US-076 — Activity leads the run, and seeks the recording

**As a** user, **I want** the current action at the top of the activity list, and each past step to say when it happened and take me there in the recording, **so that** one column answers "what is it doing now?" during the run and "show me that moment" after it.

- **Status:** ✅ Done 2026-08-09 — both tiers (see Results)
- **Priority:** P2 — no story depends on it, and both halves are UI work on
  shipped data.
- **Estimate:** ~1 day for tier 1 + tier 2 display; tier 2's seek costs more,
  because the mapping below is not the number the step already carries.
- **Depends on:** US-006 (the recording), US-026 (the step list on `/runs/<id>`)

## Context

The two views grew apart. The Run view puts the live action under the browser
pane and the steps in a rail beside it, so the thing that changes every few
seconds is in a different column from the list it will join. And it keeps a
"Watch recording" toggle that swaps the live pane for the player — which was
the only way to reach a recording before US-030 gave a run its own page. That
page now opens with the player already in place, so the toggle is a second
route to the same artifact in the view that is worst suited to hold it.

`/runs/<id>` has the player and the step list on one page and no relation
between them. Each step already carries `elapsed`, and nothing renders it.

## Details

### Tier 1 — the Run view (`frontend/src/RunView.jsx`)

- Move the `.action-bar` (`run.currentAction`) out of `.stage-main` and into
  the top of the `.stage-side` Activity card, under `CardHead`, above the log.
  The log is newest-first (`Activity.jsx`), so the current action sits directly
  above the step it becomes.
- Remove the "Watch recording" / "Back to last frame" button from
  `.verdict-actions`. "Full report" stays and is the way to the recording.
- **`showRecording` does not go with it.** The demo replay sets it from the
  `recording` event (`useRun.js:91`) because a demo carries no live frames, and
  the player is the stage feed there. What retires is the user-facing toggle:
  the `toggleRecording` action and reducer case, and `run.toggleRecording`.
  The `<video>` branch in the stage, the `Session recording` browser-bar label
  and the `.replay-note` all stay — with the button gone they are demo-only,
  which is worth a note where each sits.
- `RunView.test.jsx` asserts on the toggle; the assertion goes with the
  feature, and the demo path keeps its own.
- **Bound the URL on a row.** `.step-url` (`views.css:250`) wraps the whole URL
  today, so one step with a long query string is four lines of grey mono in a
  300px rail and pushes the steps around it off screen. Clamp it to one line
  with an ellipsis, and put the full URL in `title` so hovering still recovers
  it. In CSS, not by cutting the string in JS — a truncated string cannot be
  selected or copied, and this list is where a URL gets copied out of.
  This reverses the note above that rule, which chose full wrapping so the path
  could tell two steps on the same host apart. The path still can: it is the
  *front* of the URL that repeats, so clamp from the right and the differing
  tail is what the ellipsis eats. If that turns out to be the wrong end for
  real runs, the alternative is a middle ellipsis, which costs a JS format
  helper and a `title` — worth it only if the one-line clamp proves unreadable.
  One rule for both views: the wide column on `/runs/<id>` shows more of the
  same single line, and no second rule can drift from this one.

### Tier 2 — `/runs/<id>`: a timestamp per row, and a seek (`RunDetail.jsx`)

- `ActivityLog` renders a timestamp per step from `elapsed`, formatted `m:ss`.
  Render it in both views — `elapsed` arrives live too — and keep the row
  clickable only where a player exists, which the caller decides by passing a
  handler. `progress` and `blocked` events carry no `elapsed` and get no
  timestamp.
- A click seeks the `<video>` in `RunDetail`'s `recording` block. The element
  needs a ref; the page already owns it.
- No recording (`has_recording` false, pruned artifacts, a run still in
  flight) means no handler, so the rows are text, not dead buttons.

### The mapping is the work, and it is not `elapsed`

`elapsed` is wall-clock seconds since the run started. The recording is
**condensed**: Chromium emits a screencast frame only when the page repaints,
and `SessionRecorder` samples those at `RECORD_FPS` (3). Idle time is not in
the file. So a step at `elapsed: 41.0` is not at second 41 of the video, and
the gap grows with every wait the run sat through. Seeking to `elapsed` looks
right on a busy run and is silently wrong on a slow one — which is the failure
worth designing against, because nobody reports it as a bug.

The number that does map is the recorder's frame counter at the step boundary:

    video_seconds = frames_recorded_when_the_step_began / RECORD_FPS

`SessionRecorder.frames` already counts exactly the admitted frames, and the
encoder starts on the first of them, so frame 0 is video t=0.

Carrying it end to end:

- `agent/step_events.py` — `step_event` gains the field. The module stays
  browser-free, so the counter arrives as a callable through `callback(...)`,
  the way `run_started` does.
- `agent/run_agent.py` — passes `lambda: recorder.frames`, or a source that
  reads 0 when there is no recorder.
- `server/src/runEvents.js` — the typedef, in the same commit (that file says
  so itself).
- `server/src/runState.js` — `stepsOf` passes it through, which is what puts it
  in `report_data.json` and on `GET /api/runs/:id/steps` at once.
- Runs recorded before this ship have no such field. They get a timestamp and
  no seek. **No fallback to `elapsed`** — a jump that lands somewhere plausible
  and wrong is worse than a row that does not jump.

**Assertion-first candidate** (`CLAUDE.md` workflow rule): frames-to-seconds is
slot math against a lazily started encoder, it is off-by-one in two places
(first admitted frame, step boundary vs. the frame that follows it), and it
fails quietly. The maintainer writes the assertion before the implementation,
and the work owes a row in
[`correctness-critical.md`](../../../correctness-critical.md) when it happens.

### One open call

The row shows `elapsed`, the player's own control bar shows video time, and the
two disagree by however long the run sat idle. Recommendation: show `elapsed`.
"When did this happen" is a fact about the run; video time is an artifact of how
the file was encoded, and it is the number nobody asked for. Accept that the
player lands at a different reading.

## Results — tier 1 (2026-08-09)

`RunView.jsx`, `useRun.js`, `Activity.jsx`, `views.css`, `App.css`,
`RunView.test.jsx`.

**The action bar is gone rather than moved.** Put at the top of the Activity
card as planned, it was visibly a second copy of the row beneath it, and the
reducer says why: `currentAction` on a `step` event is
`next_goal || thinking || evaluation`, and `stepText` renders
`message || next_goal || thinking || evaluation` — a step carries no `message`,
so the two resolve to the same string. `progress` is `evt.message` on both
sides. `blocked` differed only in wording, and the row already showed the URL.
The bar said something no row did in exactly two moments, both of which produce
no row at all: launching, and stopping.

So the pulse moved onto the newest row instead, in place of that row's number —
the agent announces a step as it starts it, so while a run is live the top row
*is* the current action. `ActivityLog` takes a `live` prop for it; RunDetail
never passes one, where every row is history. That deleted `currentAction`,
`LAUNCHING` and the `start` case from the reducer, and collapsed `step`,
`progress` and `blocked` into one case, since appending a row is now all any of
them does. `.action-bar` left `App.css`'s `.banner` family and then left
entirely.

The two orphaned messages: launching was already covered twice over (the
stage's "Agent is starting…" spinner and the log's own "The first step lands
shortly"), so it went. Stopping kept its explanation as a `.hint` under the
card head — the header button says "Stopping…", and this says what it is
waiting for. No pulse on it: it explains a wait rather than naming what the
agent is doing.

- `hasRecording` went with the button, which the plan above did not list. It
  existed only to gate it — nothing else read it — so the `recording` event now
  returns `state` untouched for a real run and sets `showRecording` for a demo,
  which is the whole of what the event still means to this view.
- `.action-bar` is `--sunken` and borderless inside the card. Its old
  `--card` fill and hairline were how it separated itself from the page
  background under the frame; in a card those become a border inside a border,
  which is the third concentric line `.stats` already refuses to draw.
- Four tests added: the pulse is on the newest row and gone once the run ends,
  the stop's hint appears only while stopping, a finished run offers the report
  and no toggle, and a demo replay still puts a `<video>` in the stage. The last
  is the one that matters — it is the branch that deliberately did *not* go with
  the button.
- `RunView.test.jsx` had no assertion on the toggle to retire, only a comment
  in the queued-stop test naming "no report and no recording"; that clause went.
- Filed while working here: [BUG-011](./BUG-011-run-page-recording-frame-jumps-on-load.md),
  the run page's recording frame having no height until its metadata loads. Same
  family as the `.screen-empty` ratio the Run view already carries, and it will
  be under the seek work in tier 2.

## Results — tier 2 (2026-08-09)

`session_recorder.py`, `step_events.py`, `run_agent.py`, `runEvents.js`,
`runState.js`, `Activity.jsx`, `RunDetail.jsx`, `status.js`, `views.css`, and
the four test files.

The mapping landed where the plan put it, with one move: it is a
`SessionRecorder.video_seconds` property rather than arithmetic in
`step_events.py`. That object already owns both the frame counter and
`RECORD_FPS`, which are the two things the answer is made of, and its test file
already had the fake service and fake clock the assertion needed.

**The seek aims at the middle of the step's first frame, not its leading edge.**
`(frames + 0.5) / RECORD_FPS`. Reading browser-use's `VideoRecorderService`
settled the easy half: it hands imageio a fixed `fps` and appends one frame per
call, so the file is constant-rate and frame *n* sits at exactly *n*/fps, with
no timebase to reconcile. The edge is still the wrong place to aim, because
Python's float for `1/3` is a hair *below* the true value and the JSON
round-trip is another chance to lose the last bit — either drops the seek into
frame *n*−1, which shows the page as the previous step left it and says nothing
about it. Half a frame is 0.17s of margin on both sides against 0.005 of
rounding.

That reading also turned up a real defect, which is the part no assertion of
ours would have caught:

- `add_frame` swallows its own decode failures (`logger.warning`, then return)
  and returns nothing either way, so a payload it could not read is a frame the
  file never got. `SessionRecorder.add` counted it regardless. One lost frame
  puts every later step a third of a second late and the error **accumulates**
  — ten of them is 3.3s, silently. The sampler can see the reachable half of
  this for itself, so `add` now counts only a frame that carried data. That also
  makes `frames` honest on the `recording` event, which the file's own docstring
  already said had to be the encoder's tally.
- What is left is PIL failing on a well-headed but corrupt JPEG from CDP. Not
  chased: it is remote, and the only fix is a second full decode on the hot path
  of every repaint.

Accuracy, stated plainly: **frame-exact against the file, at a resolution of
0.33s**. Wall-clock cannot be tight and is not meant to be — the frame you land
on is the first repaint *after* the boundary, which on an idle page is seconds
of real time later. That is not error; the video holds nothing in between, and
the only alternative frame is the previous step's.

On the display half:

- The time shares the line under the goal with the URL, rather than taking a
  column of its own. The goal is what runs long, and a right-hand time column
  costs it ~40px in a 300px rail; the URL was already clamped to one line, so
  the time takes its own width and the URL keeps the rest.
- A row is a `<button>` only where `onSeek` **and** `video_seconds` are both
  there, a `<div>` otherwise — so a run with no recording, one still in flight,
  and one recorded before this shipped all read as text. `.log-item` keeps
  `user-select: text` through the button reset: a row is where a URL gets copied
  out of, and a button suppresses selection.
- `RunDetail` scrolls the player into view before seeking. The activity list is
  below it on a long page, so a row clicked near the bottom would otherwise seek
  something off screen.
- `stepsOf` passes the field through, so it reaches `report_data.json` and
  `GET /api/runs/:id/steps` at once. The PDF ignores it.

Two test-side notes worth keeping:

- The assertions state the landing **interval** (`n/fps <= at < (n+1)/fps`),
  never an expected float. What the number has to do is pick a frame, and that
  survives a change of fps or of rounding.
- The `record` helper drives frames at *twice* the sampling interval and asserts
  the count it reached. At exactly one interval, adding `1/3` repeatedly
  accumulates float error until a gap lands a hair under it and a frame is
  dropped — which made the arithmetic assert against a count the recorder never
  reached, and only at 9 and 40 frames. The sampler is `TestSampling`'s subject,
  not this one's.

Register row added: **Recording seek offset** in
[`correctness-critical.md`](../../../correctness-critical.md).

[BUG-011](./BUG-011-run-page-recording-frame-jumps-on-load.md) is
untouched — the player's frame still has no height until its metadata loads, and
that is now the one thing between a click and a clean jump.

## Acceptance criteria

- [x] The Run view answers "what is it doing now?" in the Activity card, not
      under the browser pane — met by pulsing the newest row rather than by the
      moved action bar this was written for; see Results
- [x] The Run view has no "Watch recording" button; the demo replay still plays
      in the stage
- [x] A step's URL takes one line however long it is, and hovering shows all of
      it
- [x] Each step row on `/runs/<id>` shows its elapsed time as `m:ss`
- [x] Clicking a step row seeks the recording to that step — to the step's first
      recorded frame, which is what "that step" can mean in a condensed replay;
      see Results
- [x] The seek lands on the step's own frames, on a run with idle time in it —
      proved by an assertion on the mapping, not by watching one video
      (`TestVideoOffset::test_idle_time_does_not_move_it` is the one that names
      it)
- [x] A run with no recording, or one recorded before this shipped, shows the
      timestamps and no seek
