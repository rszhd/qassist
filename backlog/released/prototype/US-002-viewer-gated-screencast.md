# US-002 — Viewer-gated live screencast

**As a** platform operator, **I want** the live screencast captured only while someone is actually watching, **so that** unwatched runs (e.g. CI-triggered) don't pay JPEG-encode CPU for frames nobody sees.

- **Status:** ✅ Done (2026-07-21, deployed to VPS)
- **Priority:** P1
- **Estimate:** ~2 h
- **Depends on:** —

## Details

Previously every run started the CDP screencast unconditionally. At scale most
runs are CI-triggered and never opened in the viewer.

Design (stdin control channel):

- `server.js` writes `{"cmd":"screencast","on":true|false}` to the agent child's
  stdin when the **first** viewer WebSocket attaches / the **last** one leaves
  (refcount = `run.subscribers.size`). Also sent on spawn if a viewer attached
  while the run was queued.
- `run_agent.py` `stdin_control()` reads those lines and sets/clears an asyncio
  `watch_event`; the screencast loop starts CDP capture only while set, stops it
  when cleared. Mid-run attach just starts capture late.

## Acceptance criteria

- [x] Watched run: viewer receives frames as before
- [x] Unwatched run: no frames captured, materially less CPU
- [x] Viewer attaching mid-run starts receiving frames
- [x] Tests still pass in both modes

## Results (measured on VPS, same Wikipedia test)

| | Chromium CPU time | Frames delivered |
|---|---|---|
| Unwatched (36 s run) | 4 s | none captured |
| Watched (30 s run) | 8 s | 19 frames |

Note: CDP only emits a frame when the screen changes, so frame counts look low
on mostly-static pages — that's normal.
