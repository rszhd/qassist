# US-013 — Registration-flow verification

**As a** user, **I want** the agent to complete signups that require confirmation codes, **so that** I can test my registration funnel end-to-end, not just up to the "check your email" wall.

- **Status:** 🚧 In progress — tier 1 (email) implemented 2026-07-21, pending live e2e validation
- **Priority:** P3
- **Estimate:** email tier ~2–3 days; SMS and social each ~1–2 days more
- **Depends on:** — (secrets handling via browser-use `sensitive_data`)

## Tiers (build in this order)

1. **Email confirmation** (most tractable — do first): a `get_email_code` tool
   backed by a QA mailbox (Mailosaur / Mailslurp / IMAP catch-all). Agent
   registers with a generated address, tool polls the mailbox, extracts the
   code/link, agent completes the flow.
2. **SMS / phone**: `get_sms_code` tool backed by a programmable number
   (Twilio). Per-message cost; some sites reject VoIP numbers — document as a
   known limitation.
3. **Social login**: don't automate a fresh OAuth login (fragile, bot-detected).
   Reuse a **pre-authenticated session** (persisted cookies / `storage_state`)
   or provider **test users**.

## Tier 1 implementation (2026-07-21)

- `agent/email_codes.py` — generic IMAP provider (stdlib `imaplib`, no new
  deps). Works with Gmail today (app password + plus-addressing:
  `user+qa-<runtag>@gmail.com`) and a catch-all domain later
  (`QA_MAILBOX_DOMAIN` ⇒ `qa-<runtag>@domain`). Mailosaur planned as a
  sibling provider class behind the same interface (user decision: later).
- `agent/run_agent.py` — when a mailbox is configured, registers a
  `get_email_code` tool (polls up to 180 s, reconnects per poll) and appends
  email-flow instructions to the task. Feature is fully opt-in: without the
  env vars, runs are unchanged.
- Secrets: per-run generated signup password plus the fetched code/link go
  through browser-use `sensitive_data` — the LLM only ever sees
  `<secret>qa_password</secret>` / `<secret>email_code</secret>` /
  `<secret>email_link</secret>` placeholders (substituted in action params at
  execution time), so real values never reach steps, logs, or the report.
  The tool injects code/link into the sensitive dict at runtime; browser-use
  re-reads the dict on every action.
- Code extraction: keyword-adjacent tokens containing a digit (4–10 chars),
  subject-leading digits, standalone 4–8 digits; link extraction: first URL
  matching confirm/verify/activate/token hints. Covered by smoke cases.

Env vars (set in `.env` on the VPS; server passes its env through to the
agent): `QA_IMAP_USER`, `QA_IMAP_PASSWORD` (Gmail app password — requires
2-step verification), optional `QA_IMAP_HOST` (default `imap.gmail.com`),
`QA_IMAP_PORT` (993), `QA_MAILBOX_DOMAIN`.

**Mail route decision (2026-07-21):** catch-all addresses on the user's own
domain (avoids plus-address rejection/normalization by target sites), received
via **Cloudflare Email Routing catch-all → forwarded to a dedicated Gmail
inbox**, read over Gmail IMAP with an app password. Forwarding preserves the
original `To:` header, so per-run address matching works unchanged. Set
`QA_MAILBOX_DOMAIN=<domain>` to activate. Mailosaur remains the planned
later upgrade.

## Notes

- All secrets (passwords, codes) flow through browser-use `sensitive_data` so
  they never reach the LLM in plaintext logs.
- CAPTCHA / bot detection on signup pages can still block the flow — advise
  users to disable it in test environments; not solvable by us (and shouldn't
  be).
- Test-identity provisioning (unique emails per run) belongs in the control
  plane once US-009 exists.

## Acceptance criteria (tier 1)

- [ ] Agent completes a real signup requiring an emailed code, end-to-end
- [ ] Credentials/codes absent from logs, events, and report
