# CLAUDE.md — frontend

**The URL picks the view** (react-router, US-030): `/`, `/history`,
`/schedules`, `/projects`, `/runs/<id>`, else redirect to `/`. `RunView` is
deliberately **outside `<Routes>`**, hidden not unmounted — unmounting drops the
live WebSocket and the finished run's result; routed views remount, which is how
they refresh. A new linkable thing is a `<Route>`; new *live* state that must
survive navigation goes outside `<Routes>` like Run. Express serves `index.html`
for any non-`/api` path, so a new path needs no server change.

**Before changing `App.css`/`ui.jsx` or adding a view, read
`docs/design-system.md`** — the UI vocabulary, type/spacing/size tokens and
palette. Load-bearing: tokens over raw pixels, `ui.jsx` primitives over raw
elements, dark as the default identity, a near-monochrome palette.

New views land beside the existing ones in `frontend/src/`.
