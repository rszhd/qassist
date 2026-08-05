# CLAUDE.md — server

`routes/runs.js` is the HTTP surface only — the engine stays `src/runs.js`.
`routes/projects.js` also holds the module query helpers `modules.js` imports.

**The engine is `runs.js` plus five modules below it, and the imports only ever
point downward** (US-075): `runState.js` (the registry and how a run is read —
depends on nothing) → `runRelay.js` / `runPersistence.js` → `runReport.js` /
`runReplay.js` → `runs.js` (admission, the queue, one agent process). `runs.js`
re-exports the whole surface, so nothing outside the engine imports the parts.
A new engine concern joins a layer or gets its own file **below** the one that
calls it — an import back up into `runs.js` is what this shape exists to
prevent, because a seam that points both ways is not a seam.

Mail splits three ways and stays split: `mail.js` is the transport, `notify.js`
decides who hears about a run, `mailTemplate.js` is the one layout every send
site fills in. A caller writing its own HTML is the thing that file exists to
prevent — vocabulary, constraints and the `renderEmail` spread rule:
`docs/design-system.md` → "Email".
