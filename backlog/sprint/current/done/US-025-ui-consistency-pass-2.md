# US-025 — UI consistency pass 2: type scale, sizes, dead space

**As a** user, **I want** the console's type, widths and densities to be as
consistent as its spacing now is, **so that** emphasis means something and no
view reads as a different app than the one beside it.

- **Status:** ✅ Done (2026-07-23)
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

- [x] Type scale reduced to at most five steps, every use re-pointed, and the
      count in the `App.css` comment matches reality
- [x] Repeated fixed sizes resolve to tokens; the remaining literals carry a
      one-line reason
- [x] Run view's zero state has no large unexplained empty region at 1440px
- [x] `.card-flush` deleted or used
- [x] Light theme shipped, or the "swappable from `:root` alone" claim dropped
      from CLAUDE.md and `App.css`
- [x] `cd frontend && npm run build` passes; all three views and a dialog
      screenshotted before and after (recipe in CLAUDE.md "Verify frontend
      changes")

## Results (2026-07-23)

**1. Type scale — six steps to five, whole pixels.** `10.5/11.5/12.5/13/15/18`
→ `11/12/13/16/20`. `--t-md` is gone: the body default and the controls that
sat 0.5px apart from it are now one step (`--t-base`), and the things that
were "headings at 13px" — `.empty-title`, `.verdict-head`, `.modal-head h2`,
`.brand` — moved up to `--t-lg`, which is what the old scale had no room for.
Each step is now documented as a role rather than a size, in `App.css` and in
CLAUDE.md's new *Type* paragraph. Screenshots: the three empty states and the
dialog title read as titles for the first time; nothing else moved.

**2. Sizes.** Four tokens for the numbers that repeat — `--col-side` (300px,
which absorbs History's stray 320px so all four flanking columns match),
`--rail-strip` (34px, which the grid column and the strip filling it both have
to agree on), `--scroll-cap` (240px, the activity log and the suite membership
picker) and `--dot` (6px, which unifies the WS dot at 5px with the pulse and
history dots at 6px). The browser-chrome dots stay 7px with a comment saying
they are decoration, not status. `.stats` 84px, `.add-form` 440px,
`.hist-filters select` 140px and `.list li` 36px each kept their literal and
gained the reason. The two breakpoints can't be tokens (media queries don't
read custom properties), so 900px and 1150px carry comments instead.

**3. Run view dead space — fixed by stretching, not by dropping the column.**
`.stage-split` is `align-items: stretch` and the empty activity state flexes
and centres, so the panel is exactly as tall as the browser frame beside it
whether or not a run is in flight. This keeps the "split is permanent" rule
rather than reversing it, and `--sticky-h` still caps the panel, so once a
verdict card makes the row taller than the viewport the panel is shorter than
the row again and goes back to sticking. **Left alone:** the tests rail is
still a short card. Stretching a two-row list to 620px trades one dead space
for a worse one — a tall empty card — and the rail is not what the story
named.

**4/5. Dead rules.** `.card-flush` deleted. A sweep of every class selector
against the JSX found one more, `.placeholder`, dead since the run stage was
rebuilt; deleted too. (The other unreferenced selectors are all built by
template literal in `ui.jsx` — `btn-${variant}`, `badge-${status}`,
`ws-${state}` — and are live.)

**6. Light theme shipped, dark stays the default.** One
`:root[data-theme='light']` block that restates the palette and overrides
nothing else. It was `@media (prefers-color-scheme: light)` first, which was
wrong on review: a light OS then silently decided what QAssist looked like,
and dark is the app's identity, not a preference to be inferred. The theme now
lives in a select in Settings — Dark (default) / Light / Match system — and
App.jsx resolves "Match system" to a concrete `dark`/`light` before it reaches
CSS, so the light palette is written once instead of once per selector. Dark
sets no attribute at all: the `:root` tokens already are the dark theme, so
the default costs nothing. An inline script in `index.html` applies the saved
choice before first paint, so opting out of dark doesn't cost a frame of the
wrong colour. Getting there needed
three values that were pretending not to be tokens: the topbar's
`rgba(19,19,22,.85)` (now `--bar`), the modal scrim (now `--scrim`), and
`STATUS_COLORS` in `status.js`, which held seven literal hexes and would have
left dark-theme dots on a white page — it now maps to `--fill-*` tokens, so
the JS table and the CSS palette cannot drift and a theme swap carries the
dots. That is the real value of the exercise: the "swappable from `:root`
alone" claim was false in four places, and only building the second theme
found them. Ramp inverts (`--sunken` goes greyer than the card, not blacker;
`--accent-hi` darkens on hover), verdict fills go *darker* than their dark-mode
counterparts to hold against white, and `--stage` stops being near-black —
it is the letterbox around a screenshot of someone's page, and a black
surround on a white console reads as a broken image.

## Tradeoffs

- **`--col-side` is 300px, not 320px.** Standardising up would have cost the
  live browser frame 40px, and the frame is the hero of the Run view. The
  visible cost is that a long start URL in the tests rail ellipsises a little
  sooner — `.row-sub` was already single-line-with-ellipsis by design.
- **The theme is a stored preference, not a detected one.** Following
  `prefers-color-scheme` would have been fewer lines, but it makes the default
  depend on the visitor's OS, and a console has a look. The cost is three
  states to hold instead of two, and a localStorage key (`qassist_theme`)
  beside the token.
- **The bottom three type steps are 1px apart** (11/12/13), which is not much
  distance. They are separated by weight, case and colour as well as size, and
  pushing them apart would make a dense console loose. The distance that
  mattered — body to heading — went from 0.5px to 3px.

## Notes

- Verify visually, not by reasoning about CSS: `agent/.venv` has Playwright,
  and :8081 usually has live data. The spacing pass caught its own worst bug
  (inputs 3px taller than the buttons beside them) that way.
- Keep the progressive-disclosure rule: with no projects the Run view must
  stay exactly the pre-US-023 UI.
