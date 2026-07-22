# US-025 — UI consistency pass 2: type scale, sizes, dead space

**As a** user, **I want** the console's type, widths and densities to be as
consistent as its spacing now is, **so that** emphasis means something and no
view reads as a different app than the one beside it.

- **Status:** 📋 Planned
- **Priority:** P2 (polish — nothing is broken, but every UI story from here
  inherits whatever these tokens say)
- **Estimate:** ~half a day
- **Depends on:** — (continues the spacing pass of 2026-07-23)

## Background

The spacing pass on 2026-07-23 put every margin, padding and gap on tokens,
made cards stack with `gap` instead of per-child margins, and gave controls
real height tokens — the contract is written up in CLAUDE.md's *UI
conventions*. That pass deliberately touched **only** spacing. The findings
below came out of the same audit and were left alone because they are type,
sizing and layout decisions rather than rhythm, and each one is a judgement
call worth making on purpose.

## Items

### 1. The type scale is too crowded (highest value)

Six sizes live inside 10.5→18px, and the two in the middle are not
distinguishable in use:

| Token | Size | Used for |
|---|---|---|
| `--t-xs` | 10.5px | uppercase labels, step numbers, badges |
| `--t-sm` | 11.5px | hints, row subtitles, `.btn-sm` |
| `--t-base` | 12.5px | body, buttons, inputs, rows |
| `--t-md` | 13px | body default, `.empty-title`, `.verdict-head`, `.brand` |
| `--t-lg` | 15px | stat values |
| `--t-xl` | 18px | page title |

`--t-base` and `--t-md` are 0.5px apart and get chosen interchangeably —
`.verdict-head` and `.empty-title` are "headings" at 13px while the button
beside them is 12.5px. Collapse to four or five steps with real distance
between them, then re-point every use. The comment in `App.css` already says
"five sizes for the whole app — anything that wants a sixth is usually asking
for the wrong emphasis"; there are six.

### 2. Fixed sizes are unrelated to each other

Spacing resolves to tokens; sizes do not, and the numbers disagree:

- Column widths: rail `300px`, activity `300px`, history detail `320px`,
  library projects `300px` — three columns that play the same role, two widths.
- Scroll caps: `.log` and `.member-list` both `240px` (deliberately in step —
  keep them that way).
- One-offs: `.list li` `min-height: 36px`, `.stats` `minmax(84px, …)`,
  `.add-form` `max-width: 440px`, `.screen` `min-height: 300px`,
  `.rail-strip` `34px`, `.hist-filters select` `min-width: 140px`.
- Breakpoints `900px` / `1150px`, and `--page-w: 1400px`.

Decide which of these are the same measurement wearing different numbers, give
those a token (a side-column width, a scroll cap), and leave the genuine
one-offs as literals with a comment saying why.

### 3. Run view dead space at rest

`.stage-side` sizes to its content by design, so with no run in flight the
Activity card is a short box beside a 16:9 browser frame, leaving a large empty
region under it — the first thing a new user sees. Options: let the empty
Activity state fill the row height, drop the column until there is something to
show (weighed against the "split is permanent so nothing reflows" rule in
`App.css` — that rule was chosen deliberately and should not be reversed
casually), or give the zero state something useful (recent runs for this URL).

### 4. Dead rule

`.card-flush` is declared in `App.css` and used nowhere. Delete it, or use it —
the history and library lists are plausible candidates for a flush card.

### 5. No light theme

`:root` declares `color-scheme: dark` and the tokens are structured so the
theme is swappable from that block alone, which is only a claim until a second
theme exists. Either add a light palette behind
`@media (prefers-color-scheme: light)` or stop implying one is a token swap
away. Note the near-monochrome constraint in CLAUDE.md still applies: one
neutral ramp, one accent, verdict colours below full saturation.

## Acceptance criteria

- [ ] Type scale reduced to at most five steps, every use re-pointed, and the
      count in the `App.css` comment matches reality
- [ ] Repeated fixed sizes resolve to tokens; the remaining literals carry a
      one-line reason
- [ ] Run view's zero state has no large unexplained empty region at 1440px
- [ ] `.card-flush` deleted or used
- [ ] Light theme shipped, or the "swappable from `:root` alone" claim dropped
      from CLAUDE.md and `App.css`
- [ ] `cd frontend && npm run build` passes; all three views and a dialog
      screenshotted before and after (recipe in CLAUDE.md "Verify frontend
      changes")

## Notes

- Verify visually, not by reasoning about CSS: `agent/.venv` has Playwright,
  and :8081 usually has live data. The spacing pass caught its own worst bug
  (inputs 3px taller than the buttons beside them) that way.
- Keep the progressive-disclosure rule: with no projects the Run view must
  stay exactly the pre-US-023 UI.
