# BUG-011: the recording's frame has no height until the video loads, so `/runs/<id>` jumps

**Status:** 🐛 Open
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

## Fix, when it is picked up

Give the recording's frame the capture's ratio up front, the way `.screen-empty`
does — the agent captures 1920×1080, so 16/9 is the height the video will land
at and nothing moves when it does. The rule belongs beside `.screen-empty`
rather than in a `.detail-screen` override, since both are the same statement:
this box knows its shape before it has content.

Worth checking at the same time whether the run page's *first* block reserving
its height fixes the whole column or only the top of it.
