# US-013 — Registration-flow verification

**As a** user, **I want** the agent to complete signups that require confirmation codes, **so that** I can test my registration funnel end-to-end, not just up to the "check your email" wall.

- **Status:** 📋 Planned
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
