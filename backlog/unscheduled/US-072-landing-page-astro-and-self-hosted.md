# US-072 — The landing page, onto the box and off React

**As a** visitor, **I want** `qassist.run` to arrive without downloading a
rendering framework it does not use — and, as the maintainer, so that the apex
stops being the one hostname deployed somewhere else, by someone else's build.

- **Status:** ⏸️ Unscheduled 2026-08-05 — moved out of `sprint/current/`. The
  plan below is unchanged and still costed; only its place in the queue moved.
- **Priority:** P2
- **Estimate:** ~2 h for the rewrite, plus one stand-up on the box
- **Depends on:**
  [US-007](../sprint/current/done/US-007-https-reverse-proxy.md) (Traefik,
  hostname routing and ACME) and
  [US-070](../sprint/current/US-070-user-manual-site.md) (the builder-loop
  stack this copies wholesale)

## The problem: two problems, and only one of them is real

The landing page is a Next.js app in a second repo (`qassist-landing`), hosted
on Vercel. It is one page. The stated worry was that Next.js is heavy to
self-host, and the plan was to move it onto the box beside the other five
stacks.

**The hosting worry does not survive measurement.** The site is already fully
static — no API routes, no middleware, no data fetching, no `next/image`. Adding
`output: "export"` to `next.config.ts` is a one-line change that produces plain
files, and nginx serves them. Measured, same page, same container, 1 CPU and
512 MB, 500 requests each:

| | Idle | After 500 requests |
|---|---|---|
| `next start` (Node server) | 114 MB | 125 MB |
| nginx + static export | 13 MB | 15 MB |

Note what the second row means: **there is nothing to be heavy.** Next.js is a
build tool here, not a server. And even under `next start` the page never
rendered per request — the build reports it as `○ (Static)`, prerendered once.
Those 114 MB buy a Node process that serves a file already on disk.

**The real problem is what the visitor downloads.** Measured from the export's
`index.html`, nine chunks, gzipped:

| | Client JS (gzipped) |
|---|---|
| Today | **197 KB** (658 KB raw) |
| Astro | **5.9 KB** (14.4 KB raw) |

The 5.9 KB figure is not an estimate from a benchmark. It is `lib/effects/*.ts`
plus `lib/cases.ts` bundled with esbuild and minified — the site's own code,
which is all that would remain.

## Why the React in this repo is doing nothing

Every one of the six `"use client"` components has the same shape:

```tsx
const ref = useRef<HTMLCanvasElement>(null);
useEffect(() => (ref.current ? initTraces(ref.current) : undefined), []);
```

No state, no props driving a re-render, no reactivity anywhere. React holds a
DOM node and calls one `init()` on mount. The effect modules take a plain
`HTMLElement` and never import React.

So the page ships a 197 KB rendering framework to make five `init()` calls.
Astro's `<script>` does that natively, and the effect modules, `globals.css`
(1,581 lines) and the subset `.woff2` files all move across untouched.

## What is explicitly *not* a reason to do this

Recorded so the next person does not re-argue it:

- **Not server resources.** Both approaches emit static files that nginx serves
  for 13 MB. The framework is absent at runtime either way.
- **Not SEO.** Next already prerenders 2,934 characters of visible text into
  `index.html` before any JavaScript runs. Astro prerenders the same text. This
  is a wash, and it was the original reason for looking.
- **Not first paint.** Next's chunks are deferred and do not block rendering.
  The gain is main-thread work *after* paint — interaction readiness on cheap
  phones, and Lighthouse TBT.

The single justification is 191 KB of gzipped JavaScript that does nothing the
page needs. That is enough, but it is the only one.

## Approach: two tiers that do not depend on each other

**Tier 1 — Astro, in `qassist-landing`.** Six `.tsx` components become `.astro`
files whose `<script>` imports the matching effect module. `next/font/local`
becomes five `@font-face` rules against the files already in `public/fonts/` —
they are pre-subset, so nothing is lost. The one `next/link` becomes
`<a href="#top">`. `vercel.json` goes. The `@/` path alias carries over through
`tsconfig.json`.

**Tier 2 — a sixth stack on the box.** Copy `docker-compose.docs.yml`: stock
nginx serving a `dist` volume read-only, plus a long-lived builder holding the
clone and `node_modules` in a `src` volume, polling for a push. Point
`LANDING_REPO` at `qassist-landing`. The styled 404 uses the same three Traefik
`errors` labels added for the docs site in `63818b3`, and `docker-compose.proxy.yml`
stays untouched, as its contract states.

**The tiers are independent, and the order does not matter.** Tier 2 works
today against `output: "export"`; tier 1 changes only what the builder runs.
Splitting them is what keeps a framework rewrite from being coupled to a DNS
change.

Builder-side cost, measured under 1 CPU / 512 MB:

| | `node_modules` | Cold install | Build |
|---|---|---|---|
| Next (static export) | 506 MB | 21 s | 20 s |
| Astro | 154 MB | — | ~5 s |

Both fit the cap with room. `npm ci` must **not** use `--omit=dev`: today's
`useTypeScriptCli` shells out to `tsc`, which is a devDependency.

## The files live in two repos, and that is deliberate

The rewrite is `qassist-landing`'s. The **compose file and runbook are this
repo's**, because `DEPLOY.md` states that nothing about the deployment may live
only on the box. So `docker-compose.landing.yml`, `.env.landing.example` and
`docs/deploy/landing-site.md` land here, and the publish script lands beside the
site in the other repo — the same split the docs stack has, where
`manual/publish.sh` is re-read from the clone every poll.

Three places assert the apex is hosted elsewhere and become wrong on tier 2:
`DEPLOY.md` (the "subdomain, not the apex" paragraph and the stack table),
[`docs/deploy/production.md`](../../docs/deploy/production.md) line 12, and
[US-007](../sprint/current/done/US-007-https-reverse-proxy.md) line 21. US-007
is closed, so its line is history and stays; the two live docs get corrected.

**Do not touch the MX, SPF or DKIM records.** Only the apex `A` record moves.
`DEPLOY.md` already notes that the mail records belong to the domain rather than
to any stack, and Resend's sender domain rides on them.

## This closes US-070's last marketing criterion

[US-070](../sprint/current/US-070-user-manual-site.md) is 9/11, and one of the
two open criteria is "the marketing site links to the manual — marketing is a
second repo".
`lib/links.ts` currently reads:

```ts
export const DOCS = "https://github.com/rszhd/qassist/blob/main/docs/quickstart.md";
```

That points at a contributor file on GitHub, not at `docs.qassist.run`. Fixing
it is one line, and it is part of this story rather than a stray commit in
another repo.

## Acceptance criteria

- [ ] `qassist.run` is built from Astro and ships **under 10 KB of gzipped
      JavaScript**, measured over every script the built `index.html`
      references — against 197 KB today
- [ ] The page looks and behaves the same: the hero demo, the traces canvas, the
      terminal, the monitor strip and the section reveals all still run
- [ ] `globals.css` and the subset `.woff2` files carry over unmodified, and no
      font is synthesised — nothing above weight 600 is requested
- [ ] The prerendered HTML still carries the full copy with JavaScript disabled
      (~2,900 characters of visible text), so the SEO position is not traded away
- [ ] `qassist.run` serves from the box over HTTPS on its own Let's Encrypt
      certificate, and `www` resolves the same way
- [ ] A push to the landing repo's default branch is live within one poll
      interval, with no workflow run, no image build and no registry round trip
- [ ] The whole stack is `docker-compose.landing.yml` plus `.env.landing`: no
      cron, no host script, no `nginx.conf`, and `docker-compose.proxy.yml` is
      unchanged
- [ ] A mistyped URL gets the site's own 404, not nginx's, via the Traefik
      `errors` middleware — not by mounting a config file
- [ ] Standing it up touches no other stack: `~/qassist` is only checked out,
      the builder's clone is a volume of its own, and production, staging, demo,
      preview and docs see nothing
- [ ] The apex `A` record moves and the MX, SPF and DKIM records do not; a
      magic-link email still arrives after the cutover
- [ ] `DEPLOY.md` carries the landing stack in its table and its "subdomain, not
      the apex" paragraph is corrected, `docs/deploy/production.md` line 12 with
      it, and a `docs/deploy/landing-site.md` runbook says how to publish by hand
- [ ] `lib/links.ts` points `DOCS` at `docs.qassist.run`, closing
      [US-070](../sprint/current/US-070-user-manual-site.md)'s marketing-link criterion
- [ ] `node scripts/check-doc-links.mjs` passes over the new and edited docs

## Out of scope

- **A blog.** Astro is the right host for one and content collections are the
  reason, but nothing here adds `/blog`.
- **Touching `frontend/`.** The app stays a React SPA at `app.qassist.run`.
  Astro's weakness is shared client state across islands, and that is exactly
  what the app has — this story does not go near it.
- **Merging the two repos.** The landing site stays separate, per
  [`docs/repo-model.md`](../../docs/repo-model.md); only its hosting moves.
