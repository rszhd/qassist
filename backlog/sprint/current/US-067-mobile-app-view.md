# US-067 — The app on a phone

**As** someone who gets a failure notification away from a desk — the person a
scheduled run exists for — **I want** to open the run permalink, read the
verdict and scan the step log on my phone, **so that** "did the nightly pass?"
doesn't wait until I'm back at a laptop.

- **Status:** 📋 Planned
- **Priority:** P2 — `app.qassist.run` is live (US-056) and scheduled runs mail
  a link (US-012, US-030). We already send people to a URL we have never sized
  for the device most likely to open it.
- **Estimate:** 1–2 days. Almost entirely `App.css` and `views.css`; a small
  amount of markup where a container has no element to hang a rule on.
- **Depends on:** [US-025](done/US-025-ui-consistency-pass-2.md) (the token
  vocabulary this works in), [US-030](done/US-030-run-permalink.md) (the page a
  phone most often lands on).

## The scope decision this story makes first

**A phone is for reading a result, not for driving a run.** The live Run view is
built around `--stage-min` (800px) — a floor the design system calls "the
measurement that doesn't yield," because watching an agent session in a frame
narrower than that is not watching anything. At 390px the frame is 342px wide
and 192px tall; no amount of stacking rescues that.

So the recommendation is: **History, the run permalink, Projects and Schedules
get a phone layout. Run does not.** Run must still degrade without breaking the
page — no sideways scroll, controls reachable, the goal box usable if someone
does kick off a run from a phone — but it does not get a phone-first redesign,
and the stage stays a desk object. Anything more is a different story with a
different frame.

## What is actually broken

**There is one breakpoint and it is 900px.** Below it every view collapses to a
single stack, and then nothing happens again all the way to 320px. 900px is a
tablet rule that has been doing a phone's job by accident. The concrete
consequences:

- **The top bar overflows.** `.topbar-inner` is a nowrap flex row with `--s6`
  gutters carrying the brand, four labelled nav items in a segmented control,
  and — during a run — a WS state, a status badge and the settings button.
  Rough arithmetic puts that near 600px of content at a 390px viewport, and
  `.views` has no `min-width: 0` to shrink into, so it runs off the edge and
  takes the page's horizontal scroll with it. Measure it before fixing it; the
  number above is an estimate, not a reading.
- **A stacked sticky column pins itself.** `.hist-detail` and `.proj-list` are
  `position: sticky` unconditionally, and the 900px rule only changes the grid
  template. Stacked, they stay stuck to `--sticky-top` while the pane below
  scrolls past them. `.detail-side` already has exactly this fix at 900px
  (`position: static; order: -1`) — the other two never got it.
- **iOS Safari zooms on every field.** `input, textarea, select` are
  `font-size: var(--t-base)` — 14px. Safari zooms the viewport on focus for
  anything under 16px, and it does not zoom back out. Every form in the app,
  including the goal box, does this.
- **`100vh` is not the visible height on a phone.** `--sticky-h` and `.modal`'s
  `max-height` both measure in `vh`, which on mobile is the height *without* the
  browser's retracted toolbar. The activity log and any tall modal are cut off
  by the chrome that is actually on screen. `dvh` is the fix, with `vh` as the
  fallback line above it.
- **Touch targets are 28px.** `--ctl-sm` sizes every icon button and the row
  actions. The `@media (hover: none)` rule that reveals `.row-actions` shows the
  pattern is already understood here — the targets themselves were never
  revisited.
- **Rows that assume there is room to the right.** `.page-head` (title +
  `margin-left: auto` actions), `.proj-head`, and `.modal-foot` with a
  destructive button pushed to the far end are all nowrap flex rows that need a
  wrap rule or a stacked variant below the phone breakpoint.
- **The page gutter never yields.** `--s6` (24px) each side is 13% of a 360px
  screen before any content is drawn.

## Recommended shape

Add **one breakpoint at 600px**, carrying a comment with the arithmetic it
protects, as `docs/design-system.md` requires of 900/1155/1421. Below it: the
gutter steps down to `--s4`, the nav drops its labels to icons (the segmented
control survives, which keeps it one object rather than a toolbar), page heads
wrap their actions to a second line, sticky flanking columns go static, and
`--ctl-sm` grows to a touch size. `--t-base` on form controls goes to 16px at
that width and nowhere else — it is a Safari workaround, not a type decision,
and it gets a comment saying so.

## Acceptance criteria

- [ ] `document.documentElement.scrollWidth <= clientWidth` on every view at
      320, 390 and 768 CSS px — measured, per view, and the numbers recorded
      below
- [ ] The top bar fits at 320px with a run live, badges and all
- [ ] History, the run permalink, Projects and Schedules read top-to-bottom at
      390px with no pinned column covering the content under it
- [ ] Focusing any input on iOS Safari does not zoom the viewport
- [ ] A modal and the activity log are fully reachable with the browser toolbar
      expanded (`dvh`, not `vh`)
- [ ] Every interactive target is at least 44px in its smaller dimension below
      the phone breakpoint
- [ ] Run does not scroll sideways at 320px, and its controls are reachable —
      the stage staying too small to watch is expected, not a failure
- [ ] `docs/design-system.md` gains the 600px breakpoint and the reading/driving
      split this story decided

## Notes

- This is a CSS-only change and `frontend/CLAUDE.md` is explicit about what that
  means: no comment essay, no `npm test` — jsdom does no layout, so the suite
  cannot see a stylesheet and running it proves nothing. Verification here is
  geometry read out of a real browser, not assertions.
- Measure with `page.evaluate` over the numbers in the criteria rather than
  screenshots; the failures in this story are all overflow and occlusion, which
  are values, not impressions.
- The one thing worth deciding while in here and *not* doing: whether the mailed
  failure notification should link to the run permalink rather than the app
  root. That is US-012's surface, not this one, but this story is what makes the
  answer matter.
