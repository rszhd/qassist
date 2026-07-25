# Contributing to QAssist

Thanks for looking. QAssist is AGPL-3.0-only, and self-hosting it is free
forever — see [License](#license-and-the-dco) below for what that means for a
patch you send.

## Getting the stack running

Two paths, and which one you want depends on what you're changing:

- **Just running it** — Docker only: `cp .env.example .env`, set
  `WORKER_API_TOKEN` and `OPENAI_API_KEY`, then `docker compose up --build`
  and open <http://localhost:8080>. Full detail: [Run it](README.md#run-it).
- **Working on it** — Node 22+, Python 3.11+ and Docker on the host. The
  one-time setup (agent venv with Playwright Chromium, `npm install` in
  `server/` and `frontend/`) and the two dev servers are in
  [Local development](README.md#local-development). Note that the dev server
  starts the Postgres control plane as a container for you, so Docker has to be
  running even when you aren't using the full stack.

**One dev server per port.** `predev` aborts if :8081 is taken, because
`node --watch` survives `EADDRINUSE` — a second one becomes a stale-serving
watcher racing to bind, and the symptom is a change that isn't live. If that
happens, hunt duplicate watchers and kill them by PID before re-reading your
code.

## Running the tests

Run the suite for whatever you touched; run all three if you're unsure.

```bash
cd server   && npm test && npm run check   # node --test + supertest; tsc over JSDoc
cd agent    && .venv/bin/python -m pytest   # pure stdlib units, no browser/network
cd frontend && npm test && npm run build    # Vitest, then the real build
```

`npm run check` is a typecheck, not a build: the server is plain JS with
`// @ts-check` and JSDoc types, so the annotations are load-bearing even though
there's no TypeScript step. Both server commands after any change under
`server/src/`.

The server tests need no database — the control-plane tests run the real
migrations from `db/migrations/` against an in-memory Postgres (pg-mem).

**But pg-mem is not Postgres**, and the difference has bitten this repo: it
passes broken SQL, returns wrong rows from partial indexes, doesn't bind array
params, and loses timestamp precision. SQL whose correctness depends on real
database semantics gets a real server instead —
`server/test/scheduler-postgres.test.js` is the pattern to copy, and it skips
with a reason when no server answers. The reasoning, and the mutation-testing
audit behind it, are in [`docs/testing.md`](docs/testing.md).

### What a change owes in tests

- A new endpoint gets a test.
- A pure helper you touched gets a case.
- **A red test is fixed in the code, not the assertion.** A failure caught
  something. Editing the expected value is legitimate only when the behaviour
  was *meant* to change, and then the commit message says which and why.
  Loosening, deleting or skipping an assertion to reach green is never the fix.
- Some surfaces are **assertion-first**: correctness-critical and easy to get
  subtly wrong (the scheduler claim, slot math, redaction, the billing gates).
  There the assertion is written and reviewed *before* the implementation. The
  running register is
  [`backlog/correctness-critical.md`](backlog/correctness-critical.md), and it
  is explicitly non-exhaustive — if your change looks like it belongs in that
  class, say so in the PR rather than assuming it's ordinary. CRUD and wiring
  stay test-alongside.

## House style

Read [`CLAUDE.md`](CLAUDE.md) before a first patch — it's the short version of
every decision that's already settled, and it will save you proposing one that
isn't up for debate (Express not NestJS, raw SQL not an ORM, no TypeScript build
step, no microservices or GraphQL).

Two rules that come up most often:

- **Code explains itself; comments are the exception.** Spend the effort on
  names and structure. Write a comment for a non-obvious *why* — a workaround,
  an ordering constraint, a protocol quirk — or a bare number that can't hold a
  named token. JSDoc annotations aren't comments; `npm run check` reads them.
- **Touching the UI?** Read
  [`docs/design-system.md`](docs/design-system.md) first: tokens over raw
  pixels, the `ui.jsx` primitives over raw elements, dark as the default
  identity, a near-monochrome palette.

## Branches, commits and PRs

`dev` is the working branch and pull requests target `main`. Keep a PR to one
concern; if you found two things, that's two PRs.

Planned work lives in [`backlog/`](backlog/README.md), one file per user story.
If your change implements one, read that `US-xxx` file first — it carries the
acceptance criteria your PR will be measured against, and often the decisions
that explain why the obvious approach was rejected. `ls backlog/sprint/current/`
is exactly the work still open.

Never commit secrets. `.env` is untracked and stays that way. The full history
is scanned by gitleaks and the config that keeps it honest is
[`.gitleaks.toml`](.gitleaks.toml) — it allowlists the test suite's fake
fixtures narrowly, on both path and value, so a real credential in a test file
still fails the scan. Run it yourself before opening a PR:

```bash
docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:latest git --no-banner --redact
```

## License and the DCO

QAssist is **AGPL-3.0-only** (see [`LICENSE`](LICENSE)). Contributions are
accepted under that same licence, and **copyright stays with you** — there is
no CLA and no copyright assignment.

What we ask instead is a **Developer Certificate of Origin** sign-off: one
trailer line certifying you wrote the patch, or otherwise have the right to
submit it under the AGPL. Git adds it for you:

```bash
git commit -s -m "your message"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and an address you can be reached at. The full text is at
<https://developercertificate.org/>.

The practical consequence of DCO-not-CLA, stated plainly so it isn't a
surprise: because contributors keep their copyright, relicensing QAssist later
would need every contributor's consent. That's deliberate. If your employer
ever needs QAssist under something other than the AGPL, that's a conversation
to open in an issue, not something a licence header can settle.

How the AGPL repo relates to the paid hosted tier — and why a feature lands
here by default rather than in the private one — is
[`docs/repo-model.md`](docs/repo-model.md).
