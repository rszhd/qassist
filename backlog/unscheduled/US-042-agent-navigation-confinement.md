# US-042 — Confine where the agent may navigate

**As the** operator of a QAssist instance other people can register on, **I
want** the agent's browser fenced to the hosts a run is entitled to reach,
**so that** "point the tester at a URL" cannot be turned into "read the host's
cloud metadata endpoint and tell me what it said".

- **Status:** 📋 Planned. **Correctness-critical** — a fence that is off by
  default, or that lets one spelling of an address through, is worth less than
  no fence, because it is believed. Owes a row in
  [`correctness-critical.md`](../correctness-critical.md).
- **Priority:** P1 among the unscheduled work. Staging is publicly registrable
  today.
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

**And the bar is higher than it looks, which is why this is P1-unscheduled and
not a hotfix.** Since US-039 a run is funded only by the caller's own key, so a
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

- [ ] With the default config, a run whose `start_url` is an IP literal — in
      dotted-quad, IPv6, IPv6-mapped, decimal or hex form — is refused before a
      row is written, and reports why
- [ ] A run that starts on an allowed host and is redirected to a blocked one
      stops there, with a step event naming the blocked URL
- [ ] A project with an allowlist cannot navigate outside it; the block appears
      in the run detail and the report as a `failure_reason`, not as a crash
- [ ] `QA_BLOCK_PRIVATE_NETWORKS=0` restores today's behaviour exactly, so
      testing `http://localhost:3000` still works and is documented as the
      reason the switch exists
- [ ] The agent cannot reach the compose network's own service names (`db`)
      regardless of the IP-literal setting
- [ ] Assertions written and reviewed before the implementation, covering the
      address-spelling table above
