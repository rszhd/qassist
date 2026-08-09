# BUG-011: the recording's frame has no height until the video loads, so `/runs/<id>` jumps

**Status:** ✅ Fixed 2026-08-09
**Reported:** 2026-08-09
**Area:** frontend (`frontend/src/views.css`, `frontend/src/RunDetail.jsx`)

## Symptom

Opening a run's own page, the recording's browser frame draws as a short band
under a full-width bar, then grows to the video's real height a moment later —
taking the instructions, the summary and the step log down the page with it.
Worst on a cold load, where the metadata request is a round trip; on a warm
cache it can be quick enough to read as a flicker rather than a jump.

## Root cause

`.screen` (`views.css:204`) has `min-height: 300px` and no aspect ratio; the
ratio lives in `.screen-empty`, which the Run view adds while it has no frame to
measure. `RunDetail`'s recording block renders a bare `.screen`, and its
`<video preload="metadata">` has no intrinsic size until the metadata arrives —
so the box is 300px tall until then and the video's own height after.

The Run view already solved exactly this for its live stage; the run page never
got the same treatment because a recording *always* resolves to a size
eventually, so the wrong height is temporary rather than permanent.

## Fix

`.screen-empty`'s rule gained `.detail-screen .screen` as a second selector, so
the recording's frame holds 16/9 from the first paint — the capture is
1920×1080, so that is where the video lands and nothing moves when its metadata
arrives. Beside `.screen-empty` rather than in the `.detail-screen` block at the
foot of the file, because the two are one statement: this box knows its shape
before it has content.

The open question — whether the first block reserving its height fixes the whole
column — is yes for this page. `.detail-main` stacks the recording, the
instructions, the summary, the diagnostics and the step log; only the recording
had a height it could not state, and the two blocks that arrive late (the
diagnostics and the log, on the steps fetch) are the last two, so they extend the
page downwards without moving anything above them. The rail is the grid's other
column and is unaffected either way.

A CSS-only change, so no test: jsdom does no layout and the suite cannot see a
stylesheet (`frontend/CLAUDE.md`).
