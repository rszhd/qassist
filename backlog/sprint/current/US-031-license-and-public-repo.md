# US-031 — License the code and open the repo

**As a** self-hoster, **I want** QAssist to carry a real open-source license in a public repository, **so that** I am legally allowed to run, modify and deploy it — and can see what I am running before I trust it with a browser and an API key.

- **Status:** 🧱 Repo side shipped, **history verified clean** (2026-07-25) —
  `LICENSE` (verbatim AGPL-3.0), `CONTRIBUTING.md` with the DCO, the README
  License + Contributing sections, and `.gitleaks.toml`. gitleaks is clean over
  all 114 commits. What is left is the two GitHub-side switches — **lowercase
  the repo name and flip it public** — plus rotating the box's credentials,
  which is the maintainer's to do and not a repo change.
- **Priority:** P1 (current sprint) — nothing else in the release means anything
  while the code is private and unlicensed
- **Estimate:** ~2 h (the scan is most of it)
- **Depends on:** — (but do it *last*, after US-007/US-008 have finished
  editing the docs the public will read)

**The ordering this story assumed didn't survive contact (2026-07-25).** "Do it
last, after US-007/US-008 have finished editing the docs" reads as: staging and
the CI snippet first. But US-008's criterion closes *on staging*, staging needs
an image to run, and the image needs a pipeline that needs a public repo — so
waiting on US-008 means waiting on this story. The knot has one cut: this story
and US-032 go first, on the understanding that US-008's `docs/ci.md` may still
gain a line afterwards. A public repo is not a frozen one.

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

Half-done as of 2026-07-25: the remote is already `rszhd/QAssist`, so the rename
away from `qagent-v2-backend` happened. What is left is the **case** — down to
`qassist`. That is not cosmetic: `ghcr.io` rejects an uppercase path component,
so the published image must be `ghcr.io/rszhd/qassist` whatever the repo is
called, and the README's `raw.githubusercontent.com` quick-start URLs are
safest when the two agree exactly. Both are written lowercase already.

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

  **Done 2026-07-25, and it needed a config to stay done.** gitleaks v8.30.1
  over all 114 commits: 2 findings, both the literal
  `test-key-encryption-secret-0123456789` in the BYOK tests — fixtures, because
  an AES-GCM round-trip assertion needs a key. Nothing was scrubbed. The three
  hand-checks were re-run independently and all held: the box's IP appears in
  no commit and no tracked file, the only `sk-` strings are self-describing
  fakes, and `.env` has never been in any tree.

  So the criterion below is met by `.gitleaks.toml` rather than by a clean grep:
  it allowlists those fixtures on **both** path and value (`condition = "AND"`
  — under `server/test/`, *and* carrying the `-0123456789` fixture marker), so a
  real credential pasted into a test file still fails. Verified by injecting one
  and confirming the scan went red. The file also records why the documented
  command is `gitleaks git` and not `gitleaks dir`: a `dir` scan walks the
  working directory and so reports the operator's own untracked `.env`, and
  allowlisting `.env` to quiet that would suppress the one finding that would
  matter most if it ever *were* tracked.
- The operator's own credentials on the deployed box are a separate matter from
  the repo: rotate `OPENAI_API_KEY` and `WORKER_API_TOKEN` before the URL is
  public, whatever the scan says.

## Acceptance criteria

- [x] `LICENSE` holds the unmodified AGPL-3.0 text — 661 lines fetched from
      gnu.org, ASCII, all structural markers present (including §13 *Remote
      Network Interaction*, the clause the whole licence choice turns on)
- [x] README states the licence and that self-hosting is free — a License
      section that spells out what the AGPL does and does not ask of a
      self-hoster, plus a Contributing section
- [x] `CONTRIBUTING.md` exists and states the DCO — `git commit -s`, why DCO
      rather than a CLA, and the consequence stated plainly (contributors keep
      copyright, so relicensing would need every contributor's consent)
- [x] gitleaks (or trufflehog) reports clean over the **full** history, not
      just the working tree — `gitleaks git` exits 0 over all 114 commits, with
      the narrow fixture allowlist described above
- [ ] The repo is public, named `qassist`, and a stranger can clone it and
      reach `docker compose up` from the README alone
