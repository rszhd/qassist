# CLAUDE.md — server

`routes/runs.js` is the HTTP surface only — the engine stays `src/runs.js`.
`routes/projects.js` also holds the module query helpers `modules.js` imports.

Mail splits three ways and stays split: `mail.js` is the transport, `notify.js`
decides who hears about a run, `mailTemplate.js` is the one layout every send
site fills in. A caller writing its own HTML is the thing that file exists to
prevent — vocabulary and constraints: `docs/design-system.md` → "Email".
