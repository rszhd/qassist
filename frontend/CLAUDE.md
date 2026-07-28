# CLAUDE.md — frontend

**The URL picks the view** (react-router, US-030): `/`, `/history`,
`/schedules`, `/projects/<slug>/<section>`, `/runs/<id>`, else redirect to `/`.
`RunView` is deliberately **outside `<Routes>`**, hidden not unmounted —
unmounting drops the live WebSocket and the finished run's result; routed views
remount, which is how they refresh. A new linkable thing is a `<Route>`; new
*live* state that must survive navigation goes outside `<Routes>` like Run.
Express serves `index.html` for any non-`/api` path, so a new path needs no
server change.

**Selection inside a view is URL state too.** Projects names both halves of its
master–detail in one route with optional params, so a project and the section
of it you are in are linkable, back-navigable, and survive a reload — and
because both are params on the same match, moving between them re-renders
rather than remounting the view. Which project is open is `useParams`, never a
`useState`; a second source of truth for it is how the URL and the pane drift
apart.

**Before changing `App.css`/`ui.jsx` or adding a view, read
`docs/design-system.md`** — the UI vocabulary, type/spacing/size tokens and
palette. Load-bearing: tokens over raw pixels, `ui.jsx` primitives over raw
elements, dark as the default identity, a near-monochrome palette.

**A CSS-only change stays a CSS-only change** — no comment essay, no `npm test`.
jsdom does no layout, so the suite cannot see a stylesheet; running it proves
nothing. Change it, look at it, done.

New views land beside the existing ones in `frontend/src/`.
