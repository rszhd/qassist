# CLAUDE.md — server

`routes/runs.js` is the HTTP surface only — the engine stays `src/runs.js`.
`routes/projects.js` also holds the module query helpers `modules.js` imports.

**The engine is `runs.js` plus six modules below it, and the imports only ever
point downward** (US-075): `runEvents.js` (the NDJSON shapes — types only) →
`runState.js` (the registry and how a run is read) → `runRelay.js` /
`runPersistence.js` → `runReport.js` / `runReplay.js` → `runs.js` (admission,
the queue, one agent process). `runs.js` re-exports the whole surface, so
nothing outside the engine imports the parts. A new engine concern joins a
layer or gets its own file **below** the one that calls it — an import back up
into `runs.js` is what this shape exists to prevent, because a seam that points
both ways is not a seam.

**A run and an event are typed, and that is what `npm run check` checks**
(US-073). `Run` is `runState.js`'s and every reader resolves through it; the
event shapes are `runEvents.js`'s and `run_agent.py` is their author, so a
field renamed there lands in that file **in the same commit** — the check going
red in the relay or a route is the mechanism, not a nuisance. Neither shape is
written down twice: `run_agent.py`'s docstring and `docs/architecture.md` §4.3
point at `runEvents.js` rather than restating it.

Mail splits three ways and stays split: `mail.js` is the transport, `notify.js`
decides who hears about a run, `mailTemplate.js` is the one layout every send
site fills in. A caller writing its own HTML is the thing that file exists to
prevent — vocabulary, constraints and the `renderEmail` spread rule:
`docs/design-system.md` → "Email".
