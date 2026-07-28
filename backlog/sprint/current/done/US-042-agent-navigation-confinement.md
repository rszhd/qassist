# US-042 — Confine where the agent may navigate

**As the** operator of a QAssist instance other people can register on, **I
want** the agent's browser fenced to the hosts a run is entitled to reach,
**so that** "point the tester at a URL" cannot be turned into "read the host's
cloud metadata endpoint and tell me what it said".

- **Status:** ✅ **Done** 2026-07-27, 5/6 — the sixth (a live redirect) is not
  provable in any of our test tiers and is recorded below rather than claimed.
  **Correctness-critical** — a fence that is off by default, or that lets one
  spelling of an address through, is worth less than no fence, because it is
  believed. Row added to
  [`correctness-critical.md`](../../../correctness-critical.md).
- **Priority:** P1 of the current sprint (scheduled 2026-07-27, pulled up into the
  current sprint the same day). Staging is publicly registrable today, and US-056
  is about to stand up a production that is registrable too.
- **Estimate:** ~3 h (profile fields, config, per-project allowlist) + the
  assertions.
- **Depends on:** US-021 (there is only an attacker once there are other users).

## Why now

`BrowserProfile` in browser-use 0.13.6 carries a domain policy that we pass
none of:

- `allowed_domains` — glob-matched navigation allowlist (`["*.example.com"]`).
- `prohibited_domains` — the inverse; allowlist wins where both are set.
- `block_ip_addresses` — *"Block navigation to URLs containing IP addresses
  (both IPv4 and IPv6). When True, blocks all IP-based URLs including localhost
  and private networks."* **Default `False`.**

Enforcement is real, not advisory: `SecurityWatchdog` hooks the navigation
watchdog and refuses with `reason: 'not_in_allowed_domains'`
(`browser_use/browser/watchdogs/security_watchdog.py:44`), and its own docstring
notes the check is written so a redirect chain *"can't bypass
`block_ip_addresses`"*.

Meanwhile `POST /api/runs` validates `start_url` for presence and nothing else
(`server/src/routes/runs.js:189`), and the agent runs inside the app container —
on the same compose network as `db`, and with whatever egress the VPS has.

**What this is not.** An earlier reading of this had the *demo* exposed. It is
not: US-036's interceptor sits in `createRun` before the concurrency branch
(`server/src/runs.js:295`) and replays a fixture for every trigger path, so a
demo deployment never launches Chromium at all. The exposure is the ordinary
multi-user instance — staging today, the hosted tier tomorrow, and any
self-hoster who gives a team accounts.

**And the bar is higher than it looks, which is why this is a P1 story and not a
hotfix.** Since US-039 a run is funded only by the caller's own key, so a
drive-by stranger cannot even start one; the attacker has to bring a working
OpenAI key and spend their own money to use your box as a proxy. That is a real
cost to them and a genuine mitigation. It is not a fence.

## Details

- **Instance floor.** `QA_BLOCK_PRIVATE_NETWORKS` (default **on**) sets
  `block_ip_addresses=True`. Off is the escape hatch for the self-hoster whose
  whole use case is testing `http://localhost:3000` — which is a real and
  common case, so this cannot simply be hardcoded. Note that the flag blocks
  *IP literals*, so it does not stop `http://db:5432` or any other hostname on
  the compose network; a hostname denylist (`prohibited_domains`) covers our own
  service names.
- **Per-project allowlist.** A project already owns the notification prefs
  (US-012 moved them there for the same reason: it is a thing a person owns, not
  a thing twenty tests repeat). A `allowed_domains text[]` column on `projects`,
  passed through to the profile, means a team's suite physically cannot wander
  off their staging host — useful as a guard rail long before anyone is
  malicious.
- **Rejection is a verdict, not a crash.** A blocked navigation should surface
  as a clear step event and a specific `failure_reason`, not as a generic agent
  error. Whoever set the allowlist needs to see that it fired.
- The `start_url` itself must be checked against the same policy **before** a
  row is written, so a refused run does not consume a slot or a key.

## Assertion-first notes

Every interesting failure is a spelling:

- `http://169.254.169.254`, `http://[::ffff:169.254.169.254]`,
  `http://2852039166/` (decimal IP), `http://0x7f.1/` — all address literals,
  and the block must not depend on the string looking like dotted quad.
- A permitted host that **redirects** to a blocked one, which is the case
  browser-use's own docstring calls out and therefore the one to prove we get
  right by wiring rather than by hope.
- `allowed_domains` set and `block_ip_addresses` on together: the allowlist wins
  where both apply, so a project allowlist must not silently re-open IP literals.
- The unset path is byte-for-byte today's behaviour, so a self-hoster testing
  `localhost` is not broken by a default they never chose. (Same claim shape as
  `billing-off.test.js`.)

## Acceptance criteria

- [x] With the default config, a run whose `start_url` is an IP literal — in
      dotted-quad, IPv6, IPv6-mapped, decimal or hex form — is refused before a
      row is written, and reports why
- [~] A run that starts on an allowed host and is redirected to a blocked one
      stops there, with a step event naming the blocked URL — **wired, not
      proven** (see "What could not be asserted")
- [x] A project with an allowlist cannot navigate outside it; the block appears
      in the run detail and the report as a `failure_reason`, not as a crash
- [x] `QA_BLOCK_PRIVATE_NETWORKS=0` restores today's behaviour exactly, so
      testing `http://localhost:3000` still works and is documented as the
      reason the switch exists
- [x] The agent cannot reach the compose network's own service names (`db`)
      regardless of the IP-literal setting
- [x] Assertions written and reviewed before the implementation, covering the
      address-spelling table above

## Results (2026-07-27)

Three things found while writing the assertions changed the story, and two of
them changed the design.

**1. Node's `URL` already canonicalizes the whole spelling table.** Every
address the story names collapses before we see it — `http://2852039166/` →
`169.254.169.254`, `http://0x7f.1/` → `127.0.0.1`, and the percent-encoded,
octal, fullwidth and ideographic-dot forms alike. So `isAddressLiteral` parses
first and judges the canonical host, and is four lines. The assertions are
nevertheless written against the RAW spellings, because that is what fails an
implementation that regexes the string it was handed — the dotted-quad regex is
the obvious wrong answer and it must not go green.

**2. `block_ip_addresses` does not block `localhost`.** browser-use's own
docstring says it blocks "all IP-based URLs including localhost and private
networks". It does not: `localhost`, `db` and `metadata.google.internal` are
hostnames, `_is_ip_address` never resolves, and all three sail through. The
instance floor is therefore **two** settings — the IP block and a hostname
denylist — and the denylist is not a footnote covering our compose service
names, it is what stands between a run and this app's own port. This is the
finding the story was most wrong about, and it is why `QA_DENIED_HOSTS` exists.

**3. The allowlist inverts the precedence the story predicted.** The
assertion-first note expected "the allowlist wins where both apply, so a project
allowlist must not silently re-open IP literals". It doesn't — that sentence is
about allowed vs prohibited domains. `SecurityWatchdog` checks
`block_ip_addresses` *before* `allowed_domains`, so the floor already wins. But
the real hole is one layer along: when `allowed_domains` is set, the watchdog
returns from that branch and **never reads `prohibited_domains` at all**. So a
project allowlist containing `db` would defeat the instance floor outright. The
fix is that an allowlist is validated at *write* time, which is what makes AC #5
("regardless of the IP-literal setting") true rather than hopeful.

A fourth, smaller one: the agent cannot fail closed by passing
`allowed_domains=[]`, because browser-use treats an empty allowlist as falsy and
skips the check — `[]` means *allow everything*. There is no in-band value for
"allow nothing", so an unreadable policy makes the agent refuse to start.

### What could not be asserted

**AC #2, the redirect, is wired rather than proven.** A permitted host that 302s
into a blocked one is caught by `SecurityWatchdog.on_NavigationCompleteEvent`,
which needs a live Chromium and a real redirect — no tier of ours can reach it.
What `navigation-fence.test.js` asserts instead is that the three env vars which
*arm* that watchdog actually reach the child, since an agent spawned without
them runs an unfenced browser while every other assertion in the story stays
green. Proving the redirect itself is a preview-environment check with a real
302 and belongs to whoever next touches this surface; it is not claimed here.
**Given an owner 2026-07-28:
[US-062](../../../unscheduled/US-062-live-browser-test-tier.md)**, which builds
the tier this criterion needs — and notes that `SecurityWatchdog` hangs off
`BrowserSession`, not `Agent`, so the redirect is provable without a model call.

Worth recording that the enforcement we are leaning on is upstream and not a
local patch: `security_watchdog.py`'s sha256 matches its `dist-info` RECORD in
the pristine 0.13.6 wheel, so a fresh Docker build gets the same behaviour.

### Shape

- `server/src/navigationPolicy.js` — pure: `checkStartUrl`, `isAddressLiteral`,
  `validateAllowlist`, `agentEnvFor`. `instancePolicy()` lives in `config.js` so
  the policy module stays free of an import cycle.
- The fence sits in `createRun`, the sole funnel every trigger path reaches —
  the same property US-036's demo interceptor leans on — and returns above
  `persistInsert`, which is what makes "before a row is written" structural.
- `013_navigation_confinement.sql`: `projects.allowed_domains text[]` and
  `runs.failure_reason text`. Both inert on the day they land; no backfill,
  because the correct value for every existing row is the default.
- Batch routes partial-accept a blocked member (`{ testId, blocked, error,
  reason }` inside the 200), beside US-035's unresolvable-variable `{ error }`
  and for US-028's reason: one test pointed at localhost must not cost a suite
  its other nine results.
- `agent/navigation_policy.py` builds the three `BrowserProfile` fields and maps
  a refused navigation to `failure_reason: navigation_blocked`; the block shows
  in the activity log naming the URL, and gets its own section in the PDF.
