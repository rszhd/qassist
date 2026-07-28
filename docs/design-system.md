# Design system

The visual vocabulary of the frontend — the shared components, the type scale,
the spacing rhythms, the named sizes, and the palette. **Read this before
changing `frontend/src/App.css`, `frontend/src/views.css` or
`frontend/src/ui.jsx`, or adding any view.**
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

Five steps, and each is a role rather than a nudge: `--t-xs` (12px) uppercase
micro-labels, `--t-sm` (13px) anything secondary to the line above it,
`--t-base` (14px) every primary run of text and every control, `--t-lg` (16px)
a heading or a number worth reading first, `--t-xl` (20px) the page title
alone. A sixth step is almost always the wrong emphasis asked for the wrong
way. The tokens are written in rem — the pixel values above assume the 16px
browser default, and a user who raises their browser's font size scales the
whole scale with it.

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

## Sizes

A number that appears in two rules is a measurement and gets a name; a number
that appears once stays a literal with a line saying what set it. The named ones
are `--col-side` (every column flanking the main content — the Run rail and
activity panel, History's detail, the Projects list) with `--col-side-min` (how
far such a column may be squeezed before it is owed a row of its own),
`--stage-min`, `--rail-strip`, `--scroll-cap` (how tall a list grows inside a
card before it scrolls itself) and `--dot` (status dots). Media-query
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

## Palette

The palette is near-monochrome by design: one neutral ramp, a single accent
spent only on the primary button, focus and the live pulse, and verdict colours
held below full saturation. That holds in both themes — the ramp inverts, the
constraints don't. Depth comes from hairline borders, not from gradients or
shadows — cards carry neither. A run status renders as a tinted `.badge-<status>`
pill; `statusColor()` in `status.js` maps a status to a `--fill-*` token for the
solid dots and timeline bars, so the two can't drift and a theme swap carries
the dots with it.

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
