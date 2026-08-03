# US-067 — The app on a phone

**As** someone who gets a failure notification away from a desk — the person a
scheduled run exists for — **I want** to open the run permalink, read the
verdict and scan the step log on my phone, **so that** "did the nightly pass?"
doesn't wait until I'm back at a laptop.

- **Status:** ✅ **Done** 2026-08-03, 8/8 — `1ba09f7` (the story), `780c22b`
  (the breakpoint), `727510b` (the token index the first commit missed)
- **Priority:** P2 — `app.qassist.run` is live (US-056) and scheduled runs mail
  a link (US-012, US-030). We already send people to a URL we have never sized
  for the device most likely to open it.
- **Estimate:** 1–2 days. Almost entirely `App.css` and `views.css`; a small
  amount of markup where a container has no element to hang a rule on.
- **Depends on:** [US-025](US-025-ui-consistency-pass-2.md) (the token
  vocabulary this works in), [US-030](US-030-run-permalink.md) (the page a
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

- [x] `document.documentElement.scrollWidth <= clientWidth` on every view at
      320, 390 and 768 CSS px — measured, per view, and the numbers recorded
      below
- [x] The top bar fits at 320px with a run live, badges and all
- [x] History, the run permalink, Projects and Schedules read top-to-bottom at
      390px with no pinned column covering the content under it
- [x] Focusing any input on iOS Safari does not zoom the viewport
- [x] A modal and the activity log are fully reachable with the browser toolbar
      expanded (`dvh`, not `vh`)
- [x] Every interactive target is at least 44px in its smaller dimension below
      the phone breakpoint
- [x] Run does not scroll sideways at 320px, and its controls are reachable —
      the stage staying too small to watch is expected, not a failure
- [x] `docs/design-system.md` gains the 600px breakpoint and the reading/driving
      split this story decided

## The numbers

Read out of headless Chromium at 320, 390 and 768 CSS px (`is_mobile`,
`has_touch`), on five views: Run, History, Schedules, Projects and the run
permalink. `scrollWidth` / `clientWidth` of `documentElement`:

| Width | Before | After |
|---|---|---|
| 320 | 447 / 320 — **127px over**, all five views | 320 / 320 |
| 390 | 448 / 390 — **58px over**, all five views | 390 / 390 |
| 768 | 768 / 768 | 768 / 768 |

The overflow is one element on every view: `nav.views`, 363px of labelled tabs
in a nowrap row, whose right edge landed at 403px on a 320px screen. That is
also why 320 and 390 overflow to nearly the same absolute right edge — the bar
was the same width at both, so the viewport did all the changing.

**The bar.** Its row wanted 657px at 320px with a run live: 24 gutter ×2, the
mark at 26, the nav at 363, the WS state at 75, the widest badge ("Cancelled")
at 87, the settings button at 28, three `--s4` gaps. Four 44px tabs plus a badge
and the settings button is 351px before the mark, so no icon-only pass rescues a
single row. After the fix the bar is two rows: measured at 320px, row one needs
118px (mark 26, `.top-right` 44) and row two gives the nav all 288px of the
content well; at 390px, 118 and 358. `--topbar-h` reads 110px at 320 and 390 and
80px at 768, and the rendered bar matches the token at each.

With a run live the measured parts put row one at 304px of 320 — 32 gutter, mark
26, `--s4` gap, then `.top-right` at 230 (WS 75, `--s3`, badge 87, `--s3`,
settings 44). That one is arithmetic over measured widths, not a fresh reading:
the injected run state was measured before the fix, not after.

**Pinned columns.** Before: `aside.card` stuck at `top: 68px` on all five views
once stacked, and `section.card` did the same on History and Projects. After:
none, on any view at any width. The permalink still reports four sticky
`div.diag-step` heads — those scroll inside their own container and are meant to
pin.

**Targets and type.** Below 600px, zero controls under 44px in either dimension
and zero form controls under 16px. At 768px both are present and expected — 28px
icon buttons, 26px tabs, a 14px `select` — that width is a desk.

## What was built that the story didn't ask for

- **The nav takes its own row from 900px, not 600px.** The story's shape was
  icons-only inside one row. The 657px reading says one row is not available at
  either width, so 900px carries the wrap and 600px only makes it touch-sized.
  This is the one deviation from the recommended shape; the arithmetic is in the
  rule, per `docs/design-system.md`.
- **`--gutter` became a token.** The gutter was `--s6` written out in the bar,
  the demo strip and the content well, so stepping it down at 600px needed one
  name rather than three rules. It is indexed beside `--page-w`, not in Spacing:
  it is a page measurement, not a step on the scale.
- **Per-view work the audit only found once the page stopped overflowing.** Run
  puts the stage first (it had started 1000px down a 780px screen) and `.screen`
  got `width: 100%`, without which the 16/9 ratio resolved width from min-height
  and drew 533px inside a 358px frame. History moves its detail above the list
  and hides it when empty. Projects drops its tab icons so four tabs fit. The
  permalink uncaps its log and diagnostics and wraps its facts, because a
  `title` tooltip is unreachable on touch. On Schedules a row's name had 67px
  and `.row-tag` painted over the timestamp beside it.

## What is still open

- **No real iOS Safari was in the loop.** The zoom criterion was verified as the
  condition Safari zooms on — every form control ≥16px below 600px — and the
  toolbar criterion as `dvh` in the two places that measured in `vh`. Headless
  Chromium has no retracting toolbar to test against.
- **The mailed failure notification still links to the app root, not the run
  permalink.** Left where the story put it: US-012's surface. This story is what
  makes the answer matter, and it is now cheap — the page the link would land on
  reads on a phone.

## Notes

- This is a CSS-only change and `frontend/CLAUDE.md` is explicit about what that
  means: no comment essay, no `npm test` — jsdom does no layout, so the suite
  cannot see a stylesheet and running it proves nothing. Verification here is
  geometry read out of a real browser, not assertions.
- Measure with `page.evaluate` over the numbers in the criteria rather than
  screenshots; the failures in this story are all overflow and occlusion, which
  are values, not impressions.
