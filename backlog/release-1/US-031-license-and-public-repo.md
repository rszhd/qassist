# US-031 — License the code and open the repo

**As a** self-hoster, **I want** QAssist to carry a real open-source license in a public repository, **so that** I am legally allowed to run, modify and deploy it — and can see what I am running before I trust it with a browser and an API key.

- **Status:** 📋 Planned
- **Priority:** P1 (Release 1) — nothing else in the release means anything
  while the code is private and unlicensed
- **Estimate:** ~2 h (the scan is most of it)
- **Depends on:** — (but do it *last*, after US-007/US-008 have finished
  editing the docs the public will read)

## Design decisions (2026-07-23)

**License: AGPL-3.0-only.** `docs/repo-model.md` leaned this way and the lean
is now settled. The business model is free self-host plus a paid hosted tier,
and AGPL is the licence that matches it: anyone may run QAssist for free and
forever, but a competitor who takes this code and offers it *as a service* has
to publish their changes. A permissive licence (Apache-2.0) would buy easier
corporate adoption at the price of giving a rival hosted QAssist away for
nothing; a source-available licence (BUSL) would protect more and cost the
"open source" claim, which is the product's distribution story.

Two consequences, accepted:

1. **Some companies ban AGPL internally**, so a slice of would-be self-hosters
   can't use it. That slice is not the audience the release is aimed at, and
   they are exactly the users a hosted tier can serve later.
2. **Relicensing later needs every contributor's consent**, which is why the
   contribution terms are part of *this* story and not a later one.

**Contribution terms: DCO, not a CLA.** A CLA (copyright assignment) is what
you need to relicense unilaterally later — e.g. to dual-license commercially.
It also deters drive-by contributions and needs a signing bot. A DCO
(`Signed-off-by`, checked by an Action) is one line in `CONTRIBUTING.md` and
keeps the copyright with whoever wrote the code. Pick DCO now: the repo has
one author, so relicensing consent is currently a solved problem, and a
project with no contributors does not need CLA machinery. If a company ever
wants a non-AGPL licence, that conversation happens then.

**The repo is renamed to `qassist` and flipped public** — `qagent-v2-backend`
is two names out of date and describes a backend the repo outgrew. GitHub
redirects the old remote, so existing clones keep working.

## Details

- `LICENSE` at the repo root: the verbatim AGPL-3.0 text, unmodified.
- `README.md` gains a short **License** section: AGPL-3.0-only, self-hosting is
  free forever, and a link to `docs/repo-model.md` for how the hosted tier
  relates.
- `CONTRIBUTING.md`: how to run the stack, how to run the tests, and the DCO
  line (`git commit -s`).
- **Secret scan of the full history before flipping the switch.** Already
  checked by hand on 2026-07-23 — no `sk-…` key anywhere in `git log --all -p`,
  `.env` never committed, no host IP in any tracked markdown — but redo it with
  gitleaks or trufflehog, which know patterns a grep does not. Per
  `docs/repo-model.md`, if anything *is* found, prefer a fresh squashed initial
  commit over history scrubbing.
- The operator's own credentials on the deployed box are a separate matter from
  the repo: rotate `OPENAI_API_KEY` and `WORKER_API_TOKEN` before the URL is
  public, whatever the scan says.

## Acceptance criteria

- [ ] `LICENSE` holds the unmodified AGPL-3.0 text
- [ ] README states the licence and that self-hosting is free
- [ ] `CONTRIBUTING.md` exists and states the DCO
- [ ] gitleaks (or trufflehog) reports clean over the **full** history, not
      just the working tree
- [ ] The repo is public, named `qassist`, and a stranger can clone it and
      reach `docker compose up` from the README alone
