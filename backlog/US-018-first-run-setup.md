# US-018 — First-run setup: Chromium download + settings (BYOK)

**As a** new user, **I want** the app to set itself up on first launch and ask for my OpenAI key, **so that** I can run my first test minutes after installing, using my own API budget.

- **Status:** 📋 Planned
- **Priority:** TBD (desktop track on hold)
- **Estimate:** ~1 day
- **Depends on:** US-016 (US-017 for the packaged experience)

## Details

Two pieces: getting Playwright Chromium onto the machine, and a settings UI
for user-supplied secrets. This is the desktop realization of US-005 (BYOK) —
the key never leaves the user's machine.

Chromium download:

- Don't bundle Chromium in the installer (~150 MB); download on first launch
  into the user-data dir (`PLAYWRIGHT_BROWSERS_PATH` env for both agent and
  report generation).
- First-launch screen with progress bar; on failure show the actual error
  (DNS/proxy/TLS) — not a spinner that hangs. Respect system proxy /
  `HTTPS_PROXY`.
- Escape hatches (later, demand-driven): `PLAYWRIGHT_DOWNLOAD_HOST` mirror on
  our GitHub Releases; an "offline/full" installer variant with Chromium
  pre-bundled for locked-down networks.

Settings UI:

- OpenAI API key (required — validate with a cheap API call before saving)
  and optional IMAP creds for email-confirmation runs (US-013). Stored via
  Electron `safeStorage` (OS keychain), **never** in a plaintext config file;
  injected into the agent env per spawn.
- Concurrency setting (default 1) and memory limit, with a one-line
  explanation of what they cost the user's machine.
- This screen is deliberately the future seam for accounts/licensing when a
  paid tier arrives — keep it a distinct page, not a buried modal.

Diagnostics (support burden mitigation):

- "Copy diagnostics" button: app version, OS, agent version, Chromium
  download state, last run's tail of NDJSON events (secrets already scrubbed
  by the event scrubber).

## Acceptance criteria

- [ ] Fresh machine: install → launch → guided Chromium download → enter key
      → first run passes, with no manual steps outside the app
- [ ] Invalid OpenAI key is rejected at save time with a clear message
- [ ] Key survives app restart, is not present in any file in plaintext, and
      is scrubbed from emitted events
- [ ] Download failure shows the underlying network error and a retry button
- [ ] "Copy diagnostics" produces a paste-ready report with no secrets
