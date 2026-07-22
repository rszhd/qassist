# US-019 — Installers, code signing, auto-update

**As a** user, **I want** a signed installer that keeps itself updated, **so that** installing isn't scary and I always have the latest version — and **as the** operator, auto-update is my only channel to ship the future paid version to the installed base.

- **Status:** 📋 Planned
- **Priority:** TBD (desktop track on hold)
- **Estimate:** ~1–2 days + signing-account lead time
- **Depends on:** US-016, US-017, US-018

## Details

- `electron-builder` producing: Windows NSIS installer, macOS DMG.
  **Linux later** (AppImage/tar.gz when asked for — target audience tolerates
  the wait).
- GitHub Actions matrix (windows + macos runners) builds installers **and**
  the per-platform frozen agent (US-017); artifacts published to GitHub
  Releases. Releases are the free hosting for both downloads and updates.
- Signing (accounts have lead time — start early):
  - macOS: Apple Developer ($99/yr), notarization in CI.
  - Windows: OV code-signing cert; sign installer **and** the frozen agent
    binary (AV/SmartScreen reputation accrues per signed binary).
- `electron-updater` against GitHub Releases; check on launch, download in
  background, apply on quit. Ship this in the **first** public build — an
  unupdatable v0.1 in the wild defeats the whole free-now/paid-later plan.
- Versioning: single app version stamps shell + agent together; agent and
  shell are never mixed across versions.
- Later hardening: offline/full installer variant with bundled Chromium
  (US-018 escape hatch), Linux packages, MSIX/store distribution if wanted.

## Acceptance criteria

- [ ] CI produces signed Windows + macOS installers from a git tag, no
      laptop involved
- [ ] Fresh install on both OSes: no unsigned-software wall (SmartScreen
      reputation may lag — no red warning at minimum), first run passes
- [ ] Publishing release N+1 updates an installed N automatically on next
      launch
- [ ] Frozen agent binary inside the bundle is itself signed
