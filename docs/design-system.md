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

## Type

Five steps, and each is a role rather than a nudge: `--t-xs` (11px) uppercase
micro-labels, `--t-sm` (12px) anything secondary to the line above it,
`--t-base` (13px) every primary run of text and every control, `--t-lg` (16px)
a heading or a number worth reading first, `--t-xl` (20px) the page title
alone. A sixth step is almost always the wrong emphasis asked for the wrong
way.

## Spacing

Every margin, padding and gap is a token — no raw pixels. The scale is `--s05`
(2px) through `--s10` (40px), all multiples of 4 including the `--s05`/`--s15`
half-steps, which exist so component interiors stop inventing 5/7/9/11px. Three
rhythms and only three: `--s2` inside a `.group`, `--s3` between the blocks of a
card, `--s4` between cards and between form fields. A card sets that distance
with `gap` — `.card`, `.suites`, `.run-detail` and `.group` are flex columns —
so **nothing adds `margin-top` to separate itself from a sibling**; a new block
dropped into a card is spaced correctly by existing there. Dividers inside a
card (`.card > .hint`, `.detail-goal`, `.suites`) are a `border-top` plus
`padding-top: var(--s3)`, the gap above supplying the matching half. Anything
one line tall — button, input, select — is `--ctl` (32px) or `--ctl-sm` (28px),
set as a height rather than padded to it, which is what keeps an input level
with the button beside it. Sticky columns use `--sticky-top`/`--sticky-h`, so
they sit one gutter under the bar like any other card.

## Sizes

A number that appears in two rules is a measurement and gets a name; a number
that appears once stays a literal with a line saying what set it. The named ones
are `--col-side` (every column flanking the main content — the Run rail and
activity panel, History's detail, the Projects list), `--rail-strip`,
`--scroll-cap` (how tall a list grows inside a card before it scrolls itself)
and `--dot` (status dots). Media-query breakpoints can't read tokens, so 900px
and 1150px each carry a comment saying what they protect.

## Palette

The palette is near-monochrome by design: one neutral ramp, a single accent
spent only on the primary button, focus and the live pulse, and verdict colours
held below full saturation. That holds in both themes — the ramp inverts, the
constraints don't. Depth comes from hairline borders, not from gradients or
shadows — cards carry neither. A run status renders as a tinted `.badge-<status>`
pill; `statusColor()` in `status.js` maps a status to a `--fill-*` token for the
solid dots and timeline bars, so the two can't drift and a theme swap carries
the dots with it.
