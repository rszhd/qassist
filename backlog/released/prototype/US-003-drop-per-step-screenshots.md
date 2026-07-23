# US-003 — Stop saving unused per-step screenshots

**As a** platform operator, **I want** the agent to stop writing per-step PNGs nobody reads, **so that** runs don't waste CPU, disk I/O, and ever-growing storage.

- **Status:** ❌ Superseded by [US-020](../../release-2/US-020-report-v2-screenshots-recording.md) (2026-07-22)
- **Priority:** —
- **Estimate:** ~5 min
- **Depends on:** —

> **Superseded:** the release-1 report embeds per-step screenshots, so the
> PNGs are no longer unused. The storage concern (unbounded `runs/` growth)
> moved into US-020 as retention/cleanup.

## Details

The `on_step` callback in `agent/run_agent.py` base64-decodes and saves a
full-resolution PNG to `runs/<runId>/step_N.png` on every step. The single-page
PDF report doesn't use them (they're a leftover from an earlier multi-page
report design). `runs/` grows forever.

## Tasks

- [ ] Delete the screenshot-save block in `on_step` (or gate behind a
      `QA_DEBUG_SCREENSHOTS` env flag)
- [ ] Keep emitting the `step` event itself (UI + report data use it)
- [ ] Verify PDF report still generates correctly
- [ ] Optional: one-off cleanup of existing `step_*.png` files on the VPS

## Acceptance criteria

- [ ] A finished run's `runs/<runId>/` contains only `report_data.json` +
      `report.pdf` (+ future recording)
- [ ] Report renders unchanged
