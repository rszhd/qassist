# US-009 — Control plane: save & reuse tests

**As a** user, **I want** to save a test (URL + goal + settings) and re-run it with one click, **so that** I don't retype goals and can build a regression suite over time.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1) — first control-plane feature; establishes Postgres; foundation for the rest of the release
- **Estimate:** ~2–3 days (includes standing up Postgres + auth model)
- **Depends on:** — (foundation for US-010/011/012 run history, scheduling, email)

## Details

This story introduces the **Postgres control plane** — the first durable state
in the system. The worker stays stateless per run (current design principle);
the control plane owns everything durable.

- Schema (initial): `users`/api keys, `tests` (name, goal, start_url,
  max_steps, model, created_at), `runs` (test_id nullable for ad-hoc, status,
  verdict, timings, artifact paths), `suites` + `suite_tests` (group tests
  for one-shot triggering — needed by US-008 CI integration).
- API: CRUD for tests and suites; `POST /api/tests/:id/run`,
  `POST /api/suites/:id/run` (both accept optional `start_url` override —
  US-008 uses it to target fresh preview URLs).
- UI: saved-test list, run button, edit form.
- Persisting `runs` rows here replaces the in-memory `runs` Map as the source
  of truth for finished runs (live relay stays in memory).
- With US-005 (BYOK): store user keys encrypted, or keep keys per-request.

## Acceptance criteria

- [ ] Create/edit/delete a saved test in the UI
- [ ] One-click re-run produces a normal run linked to the test
- [ ] Saved tests survive server restart (in-memory registry doesn't)
