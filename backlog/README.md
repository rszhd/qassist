# Backlog

One file per user story. Status lives in each file's header; this table is the
overview (keep it in sync when a story changes state).

| ID | Story | Status | Priority | Depends on |
|---|---|---|---|---|
| [US-001](US-001-chromium-memory-flags.md) | Reduce per-session Chromium memory | ✅ Done | P1 | — |
| [US-002](US-002-viewer-gated-screencast.md) | Viewer-gated live screencast | ✅ Done | P1 | — |
| [US-003](US-003-drop-per-step-screenshots.md) | Stop saving unused per-step screenshots | 📋 Planned | P2 | — |
| [US-004](US-004-per-run-memory-watchdog.md) | Per-run memory watchdog | ✅ Done | P2 | — |
| [US-005](US-005-byok-user-api-keys.md) | Bring-your-own OpenAI key (BYOK) | 📋 Planned | P1 | — |
| [US-006](US-006-session-recording.md) | Session recording (record by default) | 📋 Planned | P2 | US-003 |
| [US-007](US-007-https-reverse-proxy.md) | Public HTTPS via reverse proxy | 📋 Planned | P1 | domain |
| [US-008](US-008-cicd-integration.md) | CI/CD integration (GitHub/GitLab) | 📋 Planned | P2 | US-007 |
| [US-009](US-009-control-plane-saved-tests.md) | Control plane: save & reuse tests | 📋 Planned | P2 | — |
| [US-010](US-010-scheduled-runs.md) | Scheduled runs | 📋 Planned | P3 | US-009 |
| [US-011](US-011-run-history.md) | Run history | 📋 Planned | P3 | US-009 |
| [US-012](US-012-email-reports.md) | Email reports | 📋 Planned | P3 | US-009 |
| [US-013](US-013-registration-flow-verification.md) | Registration-flow verification | 📋 Planned | P3 | — |
| [US-014](US-014-block-heavy-resources.md) | Block heavy page resources | 📋 Planned | P3 | — |
| [US-015](US-015-horizontal-scaling-100-concurrent.md) | Horizontal scaling to ~100 concurrent | 📋 Planned | P3 | US-005, US-009 |

## Suggested order

1. **Quick wins:** US-003 (5 min) → US-004 (1 h)
2. **Product-ready:** US-007 (HTTPS) → US-005 (BYOK) → US-006 (recording)
3. **Integrations:** US-008 tier 1 → US-009 → US-010/011/012
4. **Scale & depth:** US-014 → US-015 → US-013, US-008 tiers 2–3

## Conventions

- File name: `US-NNN-short-slug.md`; never reuse an ID.
- Header: user story sentence, then Status / Priority / Estimate / Depends on.
- Body: Details, Acceptance criteria (checkboxes), plus Results/Tradeoffs for
  finished work. Record measured numbers — they drive sizing decisions.
