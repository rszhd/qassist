# Testing a site behind Cloudflare

Your site is behind Cloudflare, QAssist runs from a server, and the run fails
without ever reaching the app. This is how you let your own tester through.

**There is no QAssist domain to allowlist.** Cloudflare sits in front of *your*
site and QAssist is the client making the request — nothing about `qassist.run`
appears in the traffic. What you allowlist is the IP your QAssist box makes
requests from.

This only applies to sites whose WAF you control. Against someone else's site, a
datacenter IP getting challenged is the expected outcome and not a bug.

## Why an IP Access Rule and not a WAF custom rule

The obvious move is a WAF custom rule with a *Skip* action. On the Free plan
that silently does not work: **Bot Fight Mode does not run on the Ruleset
Engine**, so `Skip`, `Bypass` and `Allow` in a custom rule have no effect on it.

An *IP Access Rule* is evaluated earlier and does exempt the request. So:

- **Free plan / Bot Fight Mode on** → IP Access Rule. It is the only thing that
  works.
- **Pro and up with Super Bot Fight Mode or Bot Management** → those *do* run on
  the Ruleset Engine and support Skip, so a WAF custom rule works too and lets
  you scope the exemption far more tightly. Prefer it if you have it.

## The recipe

**1. Find the egress IP.** The agent runs inside the app container on a bridge
network, so it leaves via the host's public IP. Don't assume — ask:

```sh
docker compose exec qassist curl -s https://ifconfig.me
```

**2. Add the rule.** Cloudflare dashboard → the zone under test → **Security →
WAF → Tools → IP Access Rules**:

| Field | Value |
| --- | --- |
| IP | the address from step 1 |
| Action | **Allow** |
| Zone | *this website* — not "all websites in the account" |
| Notes | `QAssist test runner` |

**3. Verify** before trusting a run. From the box, not your laptop:

```sh
docker compose exec qassist curl -sI https://your-site.example/ | head -1
```

A `200` means you're through. A `403`, or a `503` with `cf-mitigated:
challenge`, means the rule isn't matching — re-check the IP, and check whether
the zone you edited is the one actually serving that hostname.

## What this costs you

An `Allow` IP Access Rule is blunt: it **bypasses your custom rules, rate
limiting rules, and WAF Managed Rules** for that address, not just the bot
check. Two consequences worth being deliberate about:

- **Anything sharing that IP inherits the exemption.** If the box sits behind
  shared NAT, or you later run other things on it, they are all unprotected
  against that zone.
- **You are no longer testing the WAF.** A run that passes proves the app works;
  it no longer proves a real visitor gets through. If that distinction matters,
  point QAssist at a staging zone with production-like rules rather than
  exempting production.

The tightest version is a dedicated staging zone plus a box that exists only to
run QAssist. Where you have Super Bot Fight Mode, a Skip custom rule scoped to
one hostname is narrower than an account-wide IP allow and is the better tool.

## What this does not solve

**A dynamic egress IP.** If the box's address changes, the rule silently stops
matching and runs start failing again. Re-check with step 1 before assuming the
app broke.

**A blocked run still reports as a failed one.** QAssist does not currently
distinguish "Cloudflare never let us in" from "your signup flow is broken" — a
challenge page burns the step budget and lands in the report as a **FAIL**. So
if a run fails against a WAF-protected site, verify the allowlist before you
believe the verdict.

## Sources

- [Get started with Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)
  — Bot Fight Mode's separate evaluation pipeline, and why Skip has no effect.
- [IP Access Rules](https://developers.cloudflare.com/waf/tools/ip-access-rules/)
  — availability on all plans, and what an `Allow` action bypasses.
