# US-016 — Desktop shell (Electron)

**As a** user, **I want** QAssist to run as a desktop app on my own machine, **so that** tests execute on my hardware with my OpenAI key and nothing depends on a hosted server.

- **Status:** 📋 Planned
- **Priority:** TBD (desktop track on hold)
- **Estimate:** ~1 day
- **Depends on:** —

## Details

**Track strategy (sketched 2026-07-21, on hold):** candidate model is that the
free version runs entirely on the user's machine — their CPU/RAM, their OpenAI
key — and hosted features become the paid tier. Not prioritized; decision
deferred. If picked up: US-016 → US-017 → US-018 → US-019, Windows before
macOS, and `server.js` stays dual-mode (container + Electron) — never fork it.
US-018 would realize US-005 (BYOK) on desktop.

First step of the desktop track (US-016 → US-017 → US-018 → US-019). Goal of
this story is the smallest runnable desktop app: an Electron shell that hosts
the existing server and frontend unchanged. Python agent still runs via system
Python (frozen in US-017); Playwright Chromium assumed already installed
(first-run download in US-018).

- New top-level `desktop/` folder: Electron main process + `package.json`.
  Frontend and server stay where they are.
- On launch, main process starts `server/src/server.js` **in-process** (import
  and call, or spawn `node`) bound to `127.0.0.1` on a random free port, then
  opens a `BrowserWindow` pointed at it. The built Vite frontend is served by
  Express exactly as in the container.
- **Do not fork `server.js`.** Same file must keep working in the Docker
  container (hosted mode) and under Electron (desktop mode). Differences are
  env-driven: port, agent command, paths for `runs/`.
- `runs/` artifacts go to the OS user-data dir (`app.getPath('userData')`),
  passed to the server via env, not the repo folder.
- Desktop defaults: `MAX_CONCURRENT_SESSIONS=1` (user-raisable later),
  `MAX_RUN_MEMORY_MB` watchdog (US-004) stays on — on desktop it protects the
  user's machine.
- Dev loop: `npm run dev` in `desktop/` launches Electron against the local
  checkout with system Python — this stays the dev mode even after packaging
  exists.

## Acceptance criteria

- [ ] `npm run dev` in `desktop/` opens a window showing the QAssist UI
- [ ] A full run works end-to-end in the window: goal → live screencast →
      verdict → PDF report download
- [ ] Server listens on localhost only; port is random (no clash with a local
      dev server on 8080)
- [ ] Run artifacts land in the user-data dir, not the repo
- [ ] `docker compose up` hosted mode still works unchanged from the same
      branch
