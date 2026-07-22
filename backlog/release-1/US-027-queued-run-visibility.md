# US-027 — Tell the user their run is queued

**As a** user starting a run on a busy worker, **I want** the UI to say I am
waiting in a queue and how far back I am, **so that** I don't read a stalled
"Agent is starting…" spinner as a broken app.

- **Status:** 📋 Planned
- **Priority:** P2 (the throttle already works; what's missing is that it is
  invisible — and it gets worse with every user added, so it wants fixing
  before US-021 lets anyone but the operator in)
- **Estimate:** ~half a day
- **Depends on:** — (US-028 builds on the state this adds)

## Background

`MAX_CONCURRENT_SESSIONS` (default 4) caps concurrent agent runs. Over the
cap, `createRun()` pushes onto an in-memory FIFO (`runs.js:155`) and
`startNext()` drains it as slots free (`runs.js:305`). Nothing is rejected —
`POST /api/runs` returns a `runId` and `status: 'queued'` either way.

The Run view then shows a queued run exactly as it shows a starting one:

- `running` is true for both `queued` and `running` (`RunView.jsx:336`), so
  the primary button reads **"Running…"**, disabled.
- `waitingForFirstFrame` renders the spinner with **"Agent is starting… First
  frame appears after the first action (~10–15s)"** (`RunView.jsx:465-470`).

On a full worker that copy is a lie by several minutes. The user has no signal
that anyone is ahead of them, and the natural read is that the run hung.

What already exists, and doesn't need rebuilding:

- `broadcast(run, { type: 'status', status: 'running' })` fires the moment a
  run leaves the queue (`runs.js:220`), and `handleEvent`'s `status` case
  consumes it (`RunView.jsx:97`). **The transition is already wired** — only
  the waiting state is unrepresented.
- `counts()` returns `{ active, queued }` and `/api/health` publishes it
  (`server.js:49-53`). No view reads it.

## Design

1. **Position on the run.** In `createRun()`, when the run is queued, set
   `run.queuePosition = queue.length` and send a `{ type: 'status', status:
   'queued', position, concurrency: MAX_CONCURRENT }` event. In `startNext()`,
   after the shift, walk the remaining queue and re-send each run's new
   position so "3 ahead" counts down to "1 ahead" live.
2. **Live-only, like frames.** Do *not* push position events into
   `run.events` — the replay buffer would fill with stale positions and a late
   viewer would replay the whole countdown. Mirror `lastFrame`: keep the
   current one on the run and have `attachViewer` send it after the durable
   replay (`runs.js:368-377`). A viewer that attaches mid-wait then sees the
   position it is actually at.
3. **A distinct queued state in `RunView.jsx`.** Split `waitingForFirstFrame`
   into "queued" and "starting". Queued renders the spinner with honest copy —
   position ("2 runs ahead of you", "next up" at position 0) and the cap ("this
   worker runs 4 at a time") — and the primary button reads **"Queued…"**
   rather than "Running…". Once the `running` status lands, the existing
   "Agent is starting…" copy takes over unchanged.
4. **The batch note is the same problem.** Running a module of 10 tests on a
   4-slot worker queues 6 of them; `.batch-note` says "the rest run in the
   background" (`RunView.jsx:429-433`), which is true but says nothing about
   the wait. Once positions exist it can say how many are still waiting.

## Decisions to make while implementing

- **Queued runs do not survive a restart.** `recoverStaleRuns()` marks every
  `queued`/`running` row `error` with "server restarted while run was in
  flight" (`db.js:101-112`) — the queue is memory-only, so a deploy silently
  kills everyone's wait. This story does not fix that (durable queueing is
  US-015 territory), but the copy shouldn't promise more than the queue can
  keep. Worth a line in the README env table at least.
- **Position is per-worker, not per-user** — with one global FIFO, "2 ahead of
  you" may be two of your own runs. US-028 changes the dequeue order, and the
  number has to keep meaning the same thing after it.
- **History already labels this correctly** (`badge-queued`, amber). Nothing
  to change there; just don't invent a second vocabulary for the same status.

## Acceptance criteria

- [ ] Starting a run while the worker is at `MAX_CONCURRENT` shows a queued
      state with position, visibly distinct from "Agent is starting…"
- [ ] The position counts down as earlier runs finish, without a reload
- [ ] Attaching a viewer to an already-queued run (reload, or opening it from
      History mid-wait) shows the current position, not a replayed countdown
- [ ] The primary button reads "Queued…" while waiting, "Running…" after
- [ ] `cd server && npm test` covers: a run enqueued past the cap emits a
      queued status with a position, and the position updates on drain;
      `npm run check` clean
- [ ] `cd frontend && npm run build` clean

## Later

US-028 caps concurrency per user and changes `startNext()` from strict FIFO to
a fair-share pick — the position this story sends is what that story has to
keep accurate.
