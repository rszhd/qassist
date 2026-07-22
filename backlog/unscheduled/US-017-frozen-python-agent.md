# US-017 — Frozen Python agent (no system Python)

**As a** user, **I want** the app to work without installing Python, **so that** setup is download-and-run like normal desktop software.

- **Status:** 📋 Planned
- **Priority:** TBD (desktop track on hold)
- **Estimate:** ~1–2 days (expect PyInstaller fiddling)
- **Depends on:** US-016

## Details

The hard 20% of the desktop track. Freeze `agent/run_agent.py` (+
`make_report.py`, fonts) into a self-contained binary the server spawns
exactly like today — the stdin control channel and NDJSON-on-stdout contract
don't change.

- **PyInstaller onedir mode**, not onefile: onefile's self-extractor is the
  main antivirus false-positive magnet and adds startup latency.
- browser-use + Playwright need hidden-import/data-file tweaks in the
  `.spec` file; budget time for iterating. Pin exact versions (browser-use
  0.13.6 known-good).
- `agent/fonts/` and the report HTML/CSS ship inside the bundle;
  `make_report.py` paths must resolve via `sys._MEIPASS`-style lookup when
  frozen, filesystem paths when not.
- Server picks the agent command from env (set by the Electron main process):
  `AGENT_CMD=/path/to/frozen/qassist-agent` when packaged, `python3
  agent/run_agent.py` in dev and in the container. One code path, env-chosen.
- Build per-platform in CI (a PyInstaller build only targets the OS it runs
  on) — same GitHub Actions matrix US-019 needs for installers.
- Later hardening (US-019): sign the frozen binary itself, not just the
  installer; submit false positives to Microsoft if reported.

## Acceptance criteria

- [ ] On a machine **without Python installed**, a full run works end-to-end
      in the desktop app (goal → screencast → verdict → PDF with correct
      fonts)
- [ ] Frozen agent honors the stdin screencast gate (US-002) and is killable
      by the memory watchdog (US-004) — whole process tree dies
- [ ] Dev mode and Docker container still use interpreted Python, no code
      fork in `run_agent.py` or `server.js`
- [ ] Build is reproducible from CI, not a laptop-only artifact
