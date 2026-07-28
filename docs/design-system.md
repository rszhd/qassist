# Design system

The visual vocabulary of the frontend — the shared components, the type scale,
the spacing rhythms, the named sizes, and the palette. **Read this before
changing `frontend/src/App.css`, `frontend/src/views.css` or
`frontend/src/ui.jsx`, or adding any view.** Every token name and value is listed
flat under [Token index](#token-index) — reach for that rather than reading the
`:root` block, and keep it in step when a token is added, renamed or retuned
(`node scripts/check-design-tokens.mjs`, which CI runs too).
Structural/routing rules and the general architecture stay in `CLAUDE.md`.

## UI conventions

`ui.jsx` holds the shared vocabulary — `Button` (variant/size, lucide icon),
`IconButton`, `Field`, `CardHead`, `EmptyState`, `Stat`, `PageHeader`, `Modal`
— and every view is built from it rather than from raw `<button>`/`<label>`.
Icons come from `lucide-react`, never text glyphs. The stylesheet is split in two: `App.css` is the system half (tokens,
base, shell, primitives, messages) and `views.css` is per-view layout (Run,
Lists, History & Projects) — `main.jsx` imports `App.css` first so `views.css`
sees every token and overrides the primitives. Colours, spacing, sizes, type
steps and radii always resolve to a token, so the theme is swappable from
`:root` alone — the light theme lives in one `:root[data-theme='light']` block
that overrides tokens and nothing else, and needing a colour there that `:root`
doesn't already declare means some rule is reaching past the tokens. **Dark is
the default and the app's identity**; light is opt-in via the theme select in
Settings (Dark / Light / Match system, stored in `qassist_theme`), never
inferred from `prefers-color-scheme` — App.jsx resolves "Match system" to a
concrete `dark`/`light` so the palette stays written once. Each view opens with
a `PageHeader` carrying its primary action; creating and editing happen in a
`Modal`, and destructive/secondary row actions hide behind `.row-actions` until
the row is hovered or focused.

**Two kinds of tab, and they must not look alike.** The top bar's `.views` is a
segmented control and switches *views*; `.tabs` is an underlined strip and
switches sections *inside* one, as on Projects. Reading them as two levels is
the whole reason the second exists, so a new strip takes the underlined form
rather than a second segmented group. Both are links — a tab that changes what
the URL says is navigation, and gets `aria-current="page"` rather than a
`role="tab"` it doesn't behave like. What hides behind such a tab is unmounted,
not hidden, so anything live has to sit outside the strip (`frontend/CLAUDE.md`).

## Type

Five steps, and each is a role rather than a nudge: `--t-xs` (12px) the smallest
readable line — status tokens, step numbers, mono asides, `--t-sm` (13px) a card
title and anything else secondary to the line above it,
`--t-base` (14px) every primary run of text and every control, `--t-lg` (16px)
a heading or a number worth reading first, `--t-xl` (28px) the page title
alone. A sixth step is almost always the wrong emphasis asked for the wrong
way. The tokens are written in rem — the pixel values above assume the 16px
browser default, and a user who raises their browser's font size scales the
whole scale with it.

**The top step carries the scale's whole contrast, so it steps hard.** The
bottom three sit a pixel apart because weight, case and colour already separate
them; `--t-xl` has none of that help, and at its old 20px the page title was
four pixels off a row label and read as one. A scale that spans 12–20px cannot
say *what you are looking at* before it says what is in it, which is most of
what made the app read as a dense admin panel rather than as a product. 28px is
twice `--t-xs`, and it is the one place tracking is tightened
(`letter-spacing: -.022em`) — default letterfit is drawn for text and reads
loose at that size.

**Uppercase is for tokens, not for labels.** `.badge` and `.row-tag` keep it:
both are a value read off a run, and the case is what stops a trigger name
reading as part of the test name beside it. Everything that is merely a *label*
— the card title, a stat's caption, the socket state, a diagnostics step head —
is sentence case, because uppercase at 600 with letter-spacing carries far more
texture than 12px suggests, and six of those on one screen is most of what made
the app look busy. A new micro-label is sentence case at `--t-sm`.

## Spacing

Every margin, padding and gap is a token — no raw pixels. The scale is `--s05`
(2px) through `--s10` (40px), all multiples of 4 including the `--s05`/`--s15`
half-steps, which exist so component interiors stop inventing 5/7/9/11px. Three
rhythms and only three: `--s2` inside a `.group`, `--s3` between the blocks of a
card, `--s4` between cards and between form fields. A card sets that distance
with `gap` — `.card`, `.run-detail` and `.group` are flex columns — so
**nothing adds `margin-top` to separate itself from a sibling**; a new block
dropped into a card is spaced correctly by existing there. A section that
renders a fragment rather than a wrapper (the four inside Projects) inherits
that spacing from the card, which is the reason to prefer one. Dividers inside
a card (`.card > .hint`, `.goal-block`) are a `border-top` plus
`padding-top: var(--s3)`, the gap above supplying the matching half — and a
divider that belongs to the block above it instead, like the rule under
`.tabs`, is the same thing read the other way up: `border-bottom`, with the
card's gap supplying the space below. Anything
one line tall — button, input, select — is `--ctl` (32px) or `--ctl-sm` (28px),
set as a height rather than padded to it, which is what keeps an input level
with the button beside it. Sticky columns use `--sticky-top`/`--sticky-h`, so
they sit one gutter under the bar like any other card.

**The three rhythms are gaps between things; the inset around them is a fourth
number and is not one of them.** `--card-pad` (20px) is the margin a `.card`
keeps inside its own border, and it is deliberately *not* `--s4`: at the same
distance as the gap between two cards, a card read as a border drawn around
content rather than as content set into a surface, which is the difference
between a panel and a product. Modals take the same inset, so a dialog is not
tighter than the page behind it. The page gutter is one step wider again
(`--s6`), because at `--s5` the content ran almost to the edge of a wide screen.

`--card-pad` is a token and not a literal because **six rules read it back**.
Anything full-bleed inside a card — `.list`, `.log`, `.diag`, `.tabs`, the
rail's pinned group head — cancels exactly this much with a negative margin and
then pays it back as its own horizontal padding, which is what keeps a row's
text aligned with the card head above it. Written out as `--s4` in seven
places, it made the card's inset unmovable: the first attempt to change it left
every list four pixels short of the edge it was supposed to reach.

## Sizes

A number that appears in two rules is a measurement and gets a name; a number
that appears once stays a literal with a line saying what set it. The named ones
are `--col-side` (every column flanking the main content — the Run rail and
activity panel, History's detail, the Projects list) with `--col-side-min` (how
far such a column may be squeezed before it is owed a row of its own),
`--stage-min`, `--rail-strip`, `--scroll-cap` (how tall a list grows inside a
card before it scrolls itself), `--card-pad` (a card's own inset — see
Spacing, and note it is read by every full-bleed rule inside a card) and
`--dot` (status dots). Media-query
breakpoints can't read tokens, so 900px, 1155px and 1440px each carry a comment
with the arithmetic they protect.

**On Run, the live frame is the measurement that doesn't yield.** `--stage-min`
(800px) is a floor under it, and everything else on the view is sized to pay for
that floor: `--page-w` is set so all three columns hold it at once, the activity
panel compresses from `--col-side` toward `--col-side-min` to keep it, and when
the viewport can't cover both the panel stacks under the frame — minimizing the
tests rail to `--rail-strip` is what buys the panel its row back. Three columns
once left the frame at 728px, which is not a size you can watch a 1920-wide page
in; the fix was to stop treating the frame as the leftovers, not to drop a
column. So a new element on Run comes out of the flanks, never out of the frame.

The frame sets the view's **height** as well as its width: the tests rail ends
where the stage ends, and scrolls itself past that. `--sticky-h` is only its
second cap, for when the stage is the taller of the two — used alone it measures
from the top of the viewport, which the rail does not start at, so a long list
ran below the fold and grew the page for a column nothing else needed. That
"the neighbour decides" is what `.rail-col` exists to express; a flanking column
that can outgrow the frame should borrow the same trick rather than a number.

## Palette

The palette is near-monochrome by design: one neutral ramp, a single accent
spent only on the primary button, focus and the live pulse, and verdict colours
held below full saturation. That holds in both themes — the ramp inverts, the
constraints don't. Depth comes from hairline borders, not from gradients — no
surface in the app is a ramp between two colours.

**A card carries `--shadow-sm`, and it is mostly not the drop.** In dark the
token is a 1px drop plus `inset 0 1px 0 rgba(255,255,255,.03)` — a lit top
edge, which is the cue that separates a surface from the page when the two are
neutrals four units apart with one hairline between them. The border still does
the separating; this finishes it. In light there is no lit edge worth drawing
(white on `#fffdfa` is nothing), so that half is dropped and a fainter drop
carries the card alone — which is why `--shadow-sm` is one of the few tokens
whose two themes differ in *shape*, not just in value. `--shadow-lg` stays what
it was: for things that genuinely float, which means modals and nothing else.
Anything card-shaped takes the card's treatment — `--r-lg`, a hairline and
`--shadow-sm` — including `.rail-strip`, `.auth-card` and the `.browser` frame,
whose corner has to match the cards it shares a row with.

**The ramp is warm, the accent is not.** Every neutral carries a low-saturation
~36° cast; the accent stays blue against it, and that is the one part of the
warmth worth defending. `--warn` is amber and `--fill-queued` gold, so a warm
accent would put the primary button and the *running* dot in the same hue
family as two verdicts that have to be told apart at `--dot`. It also costs
nothing: a cool accent on warm neutrals is what leaves it the only saturated
thing on the page. Verdict hues keep their own temperatures for the same
reason — they are signal, not surface.

**One border deep.** A card draws a hairline; what sits inside it separates
with the `--sunken` fill alone — `.stat`, `.card-count`, `.row-tag`,
`.var-chip`, `.member-list`, `.api-key-fresh`, `.ci-code`, `.browser-url`,
inline `code`. Three concentric hairlines around a single number was the
densest the app ever got, and a nested border buys nothing the fill doesn't:
`--sunken` sits below `--bg` in dark precisely so it can do this job without
one. The exceptions are the boxes whose border *is* the signal — `.badge` and
`.diag-tag` carry a verdict in `--ok-line`/`--bad-line`/`--warn-line`, and in
the light theme that hairline is most of what makes a passed pill visible on a
white card. So: a new box inside a card gets a fill, and gets a border only if
the border is saying something the fill can't. A run status renders as a tinted `.badge-<status>`
pill; `statusColor()` in `status.js` maps a status to a `--fill-*` token for the
solid dots and timeline bars, so the two can't drift and a theme swap carries
the dots with it.

## Token index

Every token `App.css` declares, flat, with its value. The sections above are the
*why*; this is the lookup, so a rule can be written without opening the
stylesheet. **74 names — a value that isn't one of these is a rule reaching past
the system.** Colours are declared twice, in `:root` (dark, the default) and in
`:root[data-theme='light']`; everything from Spacing down is theme-invariant.

### Surfaces

| Token | Dark | Light | |
| --- | --- | --- | --- |
| `--bg` | `#17130f` | `#f7f4ef` | the page |
| `--sunken` | `#181410` | `#efebe4` | inputs, wells — *below* `--bg` in dark |
| `--card` | `#201c17` | `#fffdfa` | |
| `--raised` | `#26211b` | `#fffdfa` | modals |
| `--hover` | `#2b2620` | `#f5f1ea` | |
| `--border` | `#302b25` | `#e8e3da` | hairline, does the separating |
| `--border-hi` | `#403a33` | `#d5cfc5` | emphasis / hover border |
| `--stage` | `#100d0a` | `#ede8e0` | letterbox around the live frame |

### Text

| Token | Dark | Light | |
| --- | --- | --- | --- |
| `--text` | `#f1ede7` | `#1f1a14` | |
| `--muted` | `#a29b92` | `#625b52` | secondary |
| `--faint` | `#8a837a` | `#787067` | tertiary |

### Accent

Spent only on the primary button, focus and the live pulse. `#fff` on the
primary button is deliberately not a token — it is a property of the pairing.

| Token | Dark | Light | |
| --- | --- | --- | --- |
| `--accent` | `#4d7cf6` | `#3563d6` | |
| `--accent-hi` | `#6a92f8` | `#2a4fb3` | hover — lightens dark, darkens light |
| `--accent-line` | `#2f3d6b` | `#c2d0f1` | |
| `--accent-bg` | `#1a2033` | `#eef2fd` | |
| `--ring` | `rgba(77,124,246,.3)` | `rgba(53,99,214,.22)` | focus ring |

### Verdicts

Three weights per verdict: the plain name is text, `-line` is border, `-bg` is
surface.

| Token | Dark | Light | | Token | Dark | Light |
| --- | --- | --- | --- | --- | --- | --- |
| `--ok` | `#4cb98a` | `#1d7a55` | | `--bad` | `#e5787e` | `#b0303a` |
| `--ok-line` | `#2a5843` | `#b6dfcc` | | `--bad-line` | `#68373a` | `#f0c3c6` |
| `--ok-bg` | `#17281f` | `#eef8f3` | | `--bad-bg` | `#2b1a1c` | `#fdf1f2` |
| `--warn` | `#d9ad55` | `#8a6512` | | `--info` | `#9db2d2` | `#3d5a80` |
| `--warn-line` | `#554423` | `#ebd8a9` | | `--info-line` | `#34404f` | `#cad7e8` |
| `--warn-bg` | `#282116` | `#fbf6e8` | | `--info-bg` | `#1b2029` | `#f0f4fa` |
| `--warn-soft` | `#c7b795` | `#6d5a33` | | | | |

### Status fills

Solid dots and timeline bars. `statusColor()` in `status.js` maps a status to
one of these by name — the two tables cannot drift.

| Token | Dark | Light | | Token | Dark | Light |
| --- | --- | --- | --- | --- | --- | --- |
| `--fill-queued` | `#9c8039` | `#9a7315` | | `--fill-error` | `#d0666c` | `#c0434b` |
| `--fill-running` | `#4d7cf6` | `#3563d6` | | `--fill-completed` | `#4b453e` | `#bcb4ab` |
| `--fill-passed` | `#4cb98a` | `#1d8a5f` | | `--fill-cancelled` | `#7d93b5` | `#5c7699` |
| `--fill-failed` | `#d0666c` | `#c0434b` | | `--fill-idle` | `#564f47` | `#cac2b9` |

### Overlays and shadow

| Token | Dark | Light | |
| --- | --- | --- | --- |
| `--bar` | `rgba(23,19,15,.85)` | `rgba(247,244,239,.85)` | top bar |
| `--scrim` | `rgba(10,8,6,.66)` | `rgba(32,26,20,.32)` | behind a modal |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.03)` | `0 1px 2px rgba(30,24,19,.06)` | cards — the inset lit edge is the point, and light has none |
| `--shadow-lg` | `0 24px 64px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4)` | `0 24px 64px rgba(30,24,19,.14), 0 2px 6px rgba(30,24,19,.08)` | modals only |

### Spacing and controls

`--s05` 2px · `--s1` 4px · `--s15` 6px · `--s2` 8px · `--s3` 12px · `--s4` 16px ·
`--s5` 20px · `--s6` 24px · `--s8` 32px · `--s10` 40px

`--ctl` 32px · `--ctl-sm` 28px — set as a height, never padded to one.

### Sizes

`--card-pad` `var(--s5)`/20px · `--col-side` 300px · `--col-side-min` 250px ·
`--stage-min` 800px · `--rail-strip` 34px · `--scroll-cap` 240px · `--dot` 6px ·
`--page-w` 1480px ·
`--topbar-h` 52px · `--sticky-top` `calc(var(--topbar-h) + var(--s4))` ·
`--sticky-h` `calc(100vh - var(--sticky-top) - var(--s4))`

### Type and radii

`--t-xs` .75rem/12px · `--t-sm` .8125rem/13px · `--t-base` .875rem/14px ·
`--t-lg` 1rem/16px · `--t-xl` 1.75rem/28px  (px at the 16px browser default)

`--r-sm` 4px · `--r-md` 6px · `--r-lg` 10px — three, and each is in use

### Motion and family

`--fast` `110ms ease` · `--mono` `ui-monospace, SFMono-Regular, "SF Mono", Menlo,
Consolas, monospace`

## Email

Outgoing mail is the one surface outside the app that carries the brand, and it
lives in `server/src/mailTemplate.js` — one layout that every send site fills
in (`routes/auth.js`, `notify.js`, `activation.js`), never a per-caller HTML
string. `mail.js` stays the transport and knows nothing about bodies.

Three rules make it a different medium from the app, not just a smaller one:

- **Dark, and only dark.** Not a style choice — no client honours
  `prefers-color-scheme` reliably (Gmail ignores it and inverts *light* mail on
  its own), so a light template is two renders we don't control while a dark one
  is left alone everywhere. The colours are the `:root` tokens above, copied as
  literals because a stylesheet is the one thing an email can't have.
- **Inline styles on tables.** The Gmail app strips `<style>` for non-Gmail
  accounts and Outlook lays out with Word. Blocks (`paragraph`, `facts`,
  `panel`, `pre`, `button`, `rawLink`, `note`) exist so a caller composes from a
  vocabulary rather than writing that plumbing again.
- **Nothing loads from the network.** The wordmark is text, so there is no grey
  box behind "display images below" where the brand should be, and no pixel
  that reads as tracking. `mail-template.test.js` pins this, and pins that every
  caller-supplied string — goals, URLs, the judge's own prose — is escaped.

Every message keeps a plain-text body: it is the fallback a client renders when
it won't run the HTML, and it is the whole message under `MAIL_DEV_CONSOLE`.

To look at one before anyone receives it, run `npm run mail-preview` in
`server/` and point the app at it with
`RESEND_API_URL=http://127.0.0.1:8025/emails`. It writes what the real
composers produced, so a preview can't drift from what lands in an inbox — and
forwarding those files to a real Gmail and Apple Mail account is the only way
the render question is actually answered.
