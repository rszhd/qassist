# US-052 — Staging deploys from a branch, not a release

**As the** maintainer, **I want** `staging.qassist.run` to run whatever is on a
`staging` branch, **so that** proving a change on a real box costs a merge
instead of a version tag, and `main` becomes the record of what staging
survived rather than a branch releases are hoped at.

- **Status:** 🟡 In progress (opened 2026-07-26) — repo half written, branch not
  yet created and the box not yet moved onto `:staging`
- **Priority:** P1 (current sprint) — it is the friction [US-038](US-038-staging-environment.md)
  left behind, and it gets worse with every story that wants a real box
- **Estimate:** ~1 h repo-side, plus one deploy to move the box onto `:staging`
- **Depends on:** [US-032](US-032-release-pipeline-and-image.md) (the publish
  pipeline this forks) and [US-038](US-038-staging-environment.md) (the box)

## The problem: staging can only run a release

US-038 built staging to be "the tag being promoted", and pairing it with US-032
made that the obvious shape — a published image is what staging should run, so a
promotion is a tag change. It works, and it has one cost that only shows up once
you use it: **the only way to get code onto staging is to cut a version.**

`v0.2.1` exists because `v0.2.0` predated a `COPY` the demo fixtures needed.
`v0.2.2` exists to fix a Stripe date. `v0.2.3` exists because v0.2.2's release
run never got as far as building. Three of the four versions this project has
published were not releases in any sense a user would recognise — they were
*deploys to staging*, wearing a version number because that was the only
transport available. Every one of them moved `:latest`, which is the tag a
self-hoster gets by typing the obvious thing.

So the version number stopped meaning "a release we chose to make". Fixing that
is not a policy anyone can remember to follow; it needs a second transport.

## The drift this also closes

`release.yml` says "cut from `main`, not `dev`". As of 2026-07-26, `v0.2.3` is
on `dev` only, and `main` has received nothing since `v0.1.0`. The rule was
right and it was quietly not followed, for the same reason: `main` sat outside
the loop the work actually went round, so routing through it was pure ceremony
with nothing to show for it.

Giving `main` a job — *it holds what staging proved* — is what makes it load
bearing enough to survive contact with a hurry.

## Approach: a branch is the transport, a tag is the release

The chain is **dev → staging → main**.

- **`staging` is a branch you push.** Every push publishes
  `ghcr.io/<owner>/qassist:staging`, and the box's `.env.staging` pins that
  string once and never edits it again. Updating staging becomes `pull` +
  `up -d`.
- **`main` receives only what staging survived**, and a version tag is cut from
  there. Because nothing else reaches `main`, "production runs code staging
  proved" stops being a discipline and becomes a property of the graph — the
  same trick `release.yml` already plays with `needs: test`.
- **`:latest` moves on a release and nowhere else.** That is the whole point of
  the split, so `staging.yml` publishes `:staging` and `:staging-<sha>` and is
  deliberately incapable of touching `latest`.
- **The workflow ends at the registry.** No SSH, no deploy step —
  `docker compose pull` on the box stays a human, per `CLAUDE.md`'s
  never-auto-deploy rule.

**Two image tags, not one.** `:staging` is what the env file pins; `:staging-<sha>`
is what is *actually* running. A mutable tag alone cannot answer "what is on the
box" or be rolled back to, and the immutable one costs a line of workflow yaml.

**The alternative considered:** promote by digest — have the release re-tag the
exact image staging ran rather than rebuilding from the tagged tree. It is
strictly more honest about what was proven, and it was rejected as premature:
`main` receives staging's commits and nothing else, so the trees are identical
and what a rebuild re-proves is the build. Worth revisiting the first time a
build is non-reproducible enough for that distinction to bite.

## The trap this story has to write down

**`up -d` does not re-pull a mutable tag, and that failure looks like success.**
Compose sees the same `qassist:staging` string it already has locally, never
goes to the registry, and reports the stack up to date while the box serves last
week's build. With version tags this was correct behaviour and so nobody had to
know it; with a branch tag it is the default outcome of the obvious command.

`DEPLOY.md` therefore makes `pull` a separate step rather than folding it in, and
follows it with a digest/revision check — because the tag can no longer tell you
what you have. It is the same family as US-038's `--env-file` trap: not a bug,
just a tool behaving correctly in a setup where correct is not what you wanted.

## The one-time reconciliation

`main` is not currently an ancestor of `dev` — it carries two merge commits from
before this chain existed, and `dev` has never merged it back. So the promotion
step's `--ff-only` fails on its first use, which is the right failure at the
wrong time.

Bootstrap: merge `main` into `dev` once (it is clean), then branch `staging`
from there. From then on `main` is an ancestor of `staging` and stays one, and
the fast-forward is the mechanical proof that nothing reached `main` except
through staging. Keeping `--ff-only` rather than a plain merge is what makes
that checkable instead of assumed.

## Acceptance criteria

- [ ] A push to `staging` runs the full CI suite and, only if it is green,
      publishes `:staging` and `:staging-<sha>` — one CI run per push, not two
- [ ] Neither tag is `latest`, and `:latest` still moves only on a version tag
- [ ] `staging.qassist.run` runs `:staging`, pinned once in `.env.staging`, and a
      merge to `staging` reaches the box with no version cut and no file edited
- [ ] Deploying without `pull` is caught: the documented sequence pulls first,
      and the revision label on the running image matches the tip of `staging`
- [ ] A rollback works without a rebuild — pinning a prior `:staging-<sha>`
      returns the box to that commit
- [ ] `main` contains `staging` (the branches are reconciled, and the `v0.2.x`
      tags cut from `dev` no longer sit outside it), and a release tagged from
      `main` publishes as before
- [ ] `DEPLOY.md`, `CONTRIBUTING.md` and `CLAUDE.md` agree on dev → staging →
      main, and no other document still says PRs target `main`
