# US-071 — One command deploys a stack, and proves which one it deployed

**As the** maintainer, **I want** a single repo-held command that deploys a
named stack and then verifies from inside the container that it loaded that
stack's configuration, **so that** the last manual step of the promotion chain
cannot quietly boot production on staging's secrets.

- **Status:** 📋 Planned
- **Priority:** P1 (current sprint) — this is the only unguarded step in a chain
  that is otherwise fully automated, and it has already failed once in
  production
- **Estimate:** ~2 h, plus one deploy of each stack to prove it
- **Depends on:** [US-052](done/US-052-staging-branch-continuous-deploy.md) (the
  chain), [US-055](done/US-055-preview-environment.md) (the fourth stack) and
  [US-056](US-056-production-deployment.md) (production is live, so the failure
  this closes is a real one)

## The problem: the correct image, the wrong secrets

The pipeline is already continuous up to the registry. `ci.yml` gates every
push, `staging.yml` publishes `:staging` and `:staging-<sha>` on a merge, and
`release.yml` publishes `:x.y.z`, `:x.y` and `:latest` on a tag. None of that is
missing and none of it should gain a deploy step —
[`DEPLOY.md`](../../../DEPLOY.md)'s rule is that nothing reaches a box without
someone asking for it, and `staging.yml` says so in its own header.

What is unguarded is the step after the registry: a human, an SSH session, and
three lines of `docker compose` copied out of a runbook. Those lines carry an
argument that is invisible when it is wrong.

**Seen on the box 2026-08-05, promoting `0.5.1`** and recorded in
[production's runbook](../../../docs/deploy/production.md#deploying-a-new-version).
Production names no env file, because `docker-compose.prod.yml` reads
`${ENV_FILE:-.env}` and the default is already right. But a default applies only
to a variable that is *unset*, and [staging's stand-up](../../../docs/deploy/staging.md)
**exports** `ENV_FILE=.env.staging`. So the one shell that follows the whole
chain — staging first, production second — is exactly the shell in which
production inherits staging's env file. Production pulled the right image,
booted, reported healthy, and served staging's hostname, `SESSION_SECRET`,
`KEY_ENCRYPTION_SECRET` and test-mode Stripe keys against production's own
database.

The recovery costs more than the recreate. A session cookie or a BYOK key
written while the wrong secret was loaded was signed or encrypted with it, so
**a key saved during the window never decrypts again** and has to be re-entered
by the user who owns it.

Staging's runbook carries the mirror image of this — the `--env-file` trap —
and it fails the same way. Both are the same defect: the shell decides which
configuration a stack loads, and nothing checks the shell.

## Why a script and not a deploy job

The tempting fix is to end the promotion in CI: a job that SSHes to the box and
runs the compose commands itself. That trades a real failure for a worse one.
Production pins an immutable `:x.y.z`, so an automated deploy would have to
rewrite the box's `.env` — which turns the tag pin from an operator decision
into a side effect, and takes the rollback path with it. And it deletes the
property that `staging.yml` was written to keep.

The failure is not that a human runs the deploy. It is that the human runs three
lines whose meaning depends on invisible shell state. So the fix keeps the human
and removes the invisible state.

`scripts/deploy.sh <stack>` — where `<stack>` is `production`, `staging`, `demo`
or `preview` — takes the argument that was previously spread across a project
name, an env file and an exported variable, and derives all three from it. It
belongs in the repo rather than on the box for the reason `DEPLOY.md` already
states: a rebuilt server is that document plus `.env`, and nothing about the
deployment may live only on the box.

Four things it does, in order:

1. **Print the plan and stop.** Stack, project name, env file (or the explicit
   fact that there is none), the image pin it read, and the hostname it expects
   to serve. Production asks for a confirmation; the other three do not.
2. **Set the environment itself.** `export ENV_FILE=…` for the three stacks that
   name one, `unset ENV_FILE` for production. Never inherit it. This is the
   whole of the 2026-08-05 fix.
3. **Deploy.** `pull` then `up -d` for production, staging and demo; `build`
   then `up -d` then the bounded `buildx prune --max-used-space` for preview,
   which is the only stack that compiles what it serves.
4. **Assert, and fail.** Read `PUBLIC_BASE_URL` back out of the *running
   container* and exit non-zero unless it is the hostname that stack owns.
   Reading the command back does not catch this class; only the container does.

What it does **not** do is edit `.env`. The tag production runs stays the
operator's decision, which is what keeps rollback the same command with the
previous pin.

## This is a correctness-critical surface, and the register already says so

[`correctness-critical.md`](../../correctness-critical.md) carries a row for
**staging/production config separation** marked *Candidate — no assertion yet*,
deferred because the assertion was imagined as needing Docker in CI. The
2026-08-05 incident is that surface failing, in the production direction, while
the row sat open.

It does not need Docker. The behaviour worth asserting is which project name,
which env file and which compose files the script derives from its argument —
and that is observable by putting a stub `docker` on `PATH` that records its
argv and answers the `printenv` probe. Under `node --test`, beside the existing
server suite.

So this story is **assertion-first** per the Workflow rule in `CLAUDE.md`: the
maintainer writes and reviews the assertions, then the script is written against
them. The cases that matter are the ones that pass today by accident —
a `production` deploy in a shell that has already exported
`ENV_FILE=.env.staging`, and a stack whose container comes back with another
stack's `PUBLIC_BASE_URL`.

Closing this story turns that register row from a candidate into a guarded one.

## Acceptance criteria

- [ ] `scripts/deploy.sh <stack>` deploys any of the four stacks with the right
      project name, env file and compose files, and is what all four runbooks
      tell the operator to run
- [ ] The inheritance trap is closed: the script sets or unsets `ENV_FILE` from
      its argument alone, and a `production` deploy run in a shell that has
      already exported `ENV_FILE=.env.staging` loads production's configuration.
      Proven by running the two in that order in one shell, which is the
      sequence that failed
- [ ] It refuses rather than warns — after `up -d` it reads `PUBLIC_BASE_URL`
      from inside the running container and exits non-zero when it is not that
      stack's hostname, exercised against a deliberately wrong env file
- [ ] It prints stack, project, env file, image pin and expected hostname before
      it changes anything, and production requires a confirmation
- [ ] It never edits `.env`: rolling production back to the previous tag is the
      same command after the same one-line pin change an operator makes today
- [ ] Preview keeps what only preview does — build on the box, then the bounded
      `buildx prune --max-used-space` that stops the build cache filling the
      disk production shares
- [ ] The assertions are written and reviewed *before* the script, run under
      `node --test` against a stub `docker` on `PATH`, and cover both traps
      above
- [ ] `correctness-critical.md`'s staging/production config-separation row is no
      longer a candidate: its **Guarded by** names the new test file
- [ ] `DEPLOY.md` and the four runbooks replace their copy-paste compose lines
      with the script — keeping the raw commands only where a runbook explains
      what the script does — and `node scripts/check-doc-links.mjs` passes
- [ ] No workflow gains a deploy step: `staging.yml`'s stated rule and
      `CLAUDE.md`'s **Never auto-deploy** hold unchanged, and CI still ends at
      the registry
