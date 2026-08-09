# US-077 — The test mailbox stops being a Gmail account

**As** someone running several registration tests at once, **I want** the
confirmation email to arrive without every waiting run hammering one Gmail
account over IMAP, **so that** the number of parallel signups is bounded by the
concurrency cap I chose and not by a third party's login throttle.

- **Status:** 📋 Planned (tiered). Written and scheduled into the current
  sprint on 2026-08-09, the day the concurrency question was asked — tier 1 is
  an hour against a ceiling that fails every waiting run at once, so it does
  not wait behind tier 2's infrastructure decision.
- **Priority:** P2
- **Estimate:** tier 1 ~1h · tier 2 ~1 day · tier 3 ~0.5 day
- **Depends on:** [US-013 tier 1](done/US-013-registration-flow-verification.md)
  (the address scheme and the parsers),
  [US-007](done/US-007-https-reverse-proxy.md) (public HTTPS and the domain,
  for tier 2)

## Problem

Runs do not confuse each other's email. Each gets `qa-<tag>@<domain>` from the
first 10 hex characters of its run uuid (`agent/run_agent.py:449`), and
`_search_folder` filters twice — server-side `SEARCH … TO <addr>`, then an
exact match against `To`/`Cc`/`Delivered-To`/`X-Original-To`. The folder is
selected `readonly=True`, so no run hides a message from another by marking it
seen. That part is sound and this story does not change it.

The pressure is on the *connection*. `_fetch_newest` opens a fresh
`IMAP4_SSL` and logs in on **every poll** (`agent/email_codes.py:242`), and the
poll interval is 5s. One waiting run makes about 12 logins a minute; at the
default `MAX_CONCURRENT_SESSIONS=4` that is about 48 a minute from a single
Gmail account, all of them during the window where the run has nothing else to
do. Gmail caps simultaneous IMAP connections and throttles login rate, and when
it does, the failure is not one run losing one email — every waiting run gets
`Mailbox error` and reports its goal blocked at once.

The second cost is the shape of the store. IMAP gives no ordering that can be
trusted, which is why BUG-010's fix had to invent one:
[`_message_key`](done/BUG-010-stale-confirmation-email-returned-after-resend.md)
falls back to a digest when `Message-ID` is missing, and `since` has to stay a
fixed floor because `Date` is second-granular. Both are careful work around a
protocol that was never going to answer "which message arrived after the one I
already used".

## The chain today, and what actually needs replacing

    tested app → MX: Cloudflare Email Routing (catch-all)
               → forward → dedicated Gmail → IMAP poll from the agent

Cloudflare already holds the MX. **We are not missing a mail server; Gmail is a
store bolted onto one**, and it is the only hop with a login ceiling. Standing
up Postfix and Dovecot would replace the half that works. Receive-only mail is
the easy half — no sending means no reputation, no DKIM rotation, no bounce
handling — but it still buys an MX record, inbound port 25, TLS renewal, spam
on a catch-all domain that will get scraped, and disk growth, to reach the same
place tier 2 reaches with none of it. Run our own only if the Cloudflare
dependency is ever judged unacceptable.

## Tier 1 — hold the connection open (no infra, ships alone)

Log in once per *wait* rather than once per *poll*: `wait_for_confirmation`
opens the connection, loops `_search_folder` inside it, and closes on exit.
Four concurrent runs then hold four connections instead of making 48 logins a
minute. The reconnect-per-poll behaviour exists so a long wait cannot die on a
stale connection, so keep that property — catch the connection error and
reconnect once, rather than pre-emptively every 5s.

This is contained, ships on its own, and buys the time to do tier 2 properly.
If it is enough in practice, the rest of this story stays unscheduled, which is
the good outcome.

## Tier 2 — mail is delivered to us, not fetched by us

Cloudflare Email Routing can deliver to a Worker instead of to an address. The
Worker POSTs the raw MIME to a QAssist ingest endpoint; the server stores it
keyed by recipient; the agent long-polls `GET /api/mail/<address>?since=<seq>`
over the API and bearer token it already holds. `email_codes.py` keeps its
parsers — which are the part that is already unit-tested — and loses `imaplib`
and the blocking `to_thread` path.

What that buys beyond the ceiling:

- **Once-only delivery stops being a heuristic.** A monotone sequence per
  address replaces `_message_key` and the fixed `since` floor. BUG-010's class
  of failure cannot recur, rather than being defended against.
- **Latency drops** from "Gmail's forward delay plus up to 5s of poll" to about
  a second.
- **Per-project mailboxes become routing**, not credentials — see tier 3.

**IMAP stays** as the self-hosted provider. A self-hoster without a domain on
Cloudflare cannot use the Worker route, and self-host is always free.
`email_codes.py` already anticipated two providers with `QA_MAILBOX_PROVIDER`;
this is what that seam was for.

**The ingest endpoint is an internet-facing ingress, and that is the risky part
of this story.** Anyone can send mail to a `qa-<tag>` address today, but today
it lands in Gmail and is spam-filtered first. The endpoint needs an HMAC shared
with the Worker, a size cap, a TTL, and — the load-bearing rule — it must
accept an address only while a run owning that address is live. Note the sharp
edge that makes this more than hygiene: `email_link` is a URL the agent then
navigates to, and [US-042](done/US-042-agent-navigation-confinement.md)'s
allowlist is per-project and opt-in, so an injected link is fenced only for
projects that set one.

**Assertion-first candidate** (`CLAUDE.md` workflow rule): the address→run
binding and the sequence that makes each message deliver once. Both are the
shape the rule names — easy to get subtly wrong, wrong in a way a passing test
would not show. The maintainer writes those assertions before the
implementation, and the work owes a row in
[`correctness-critical.md`](../../correctness-critical.md) when it happens.

Where the message body lives is an open decision. Postgres is convenient and
cuts against "the DB stores metadata, never blobs"; disk beside the run
directory fits the existing rule. Decide before building, record it here.

## Tier 3 — a project can have its own mailbox

`QA_IMAP_*` is one slot per deployment, recorded as a known gap in
[`docs/auth-in-tested-flows.md`](../../../docs/auth-in-tested-flows.md). With
tier 2 in place this is a naming decision (`qa-<tag>.<project>@…` or a
subdomain per project) plus a scope check on the poll, not a second set of
credentials to store and encrypt.

## Acceptance criteria

- [ ] **Tier 1:** one login per wait, not per poll; a dropped connection still
      reconnects and the wait survives it
- [ ] **Tier 1:** logins-per-minute measured at `MAX_CONCURRENT_SESSIONS` runs
      all waiting, before and after, recorded here
- [ ] **Tier 2:** a message posted to the ingest endpoint reaches the waiting
      agent, and Gmail is out of the path for the hosted tier
- [ ] **Tier 2:** ingest rejects an unsigned post, an oversized body, and an
      address with no live run — each with its own test
- [ ] **Tier 2:** each message is delivered to the agent exactly once, by
      sequence and not by `Message-ID`; the BUG-010 scenario has a regression
      test that does not depend on message headers
- [ ] **Tier 2:** IMAP still works with `QA_IMAP_*` alone, self-hosted, with no
      Cloudflare anything
- [ ] **Tier 3:** two projects receive on separate addresses and neither can
      read the other's mail
- [ ] `docs/auth-in-tested-flows.md` and `manual/saved-sessions.md` updated —
      both currently state the instance-wide limit as permanent

## Notes

- Plus-addressing (`user+qa-<tag>@gmail.com`) remains the fallback when no
  domain is configured, and remains the weaker route: a site that normalizes
  the `+` suffix away delivers to the canonical inbox, where no run's filter
  matches it. That is a shared timeout rather than a mix-up, and the catch-all
  domain already avoids it.
- Mailosaur was US-013's planned upgrade. Tier 2 is the same capability without
  the vendor or the per-message bill, on infrastructure already owned. If tier
  2 is not built, Mailosaur is still the honest alternative to running mail.
- The dedicated Gmail can read whatever is forwarded to it, and US-013 already
  flagged that its app password sits in `.env`. Tier 2 removes that credential
  from the deployment entirely.
