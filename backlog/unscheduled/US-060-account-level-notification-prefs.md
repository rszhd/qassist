# US-060 — Notification settings a person owns, not just a project

**As** one of several people on a shared instance, **I want** my own default
notification mode and recipient list, **so that** "who hears about a failure" is
a setting I can change rather than an environment variable only the operator
can edit.

- **Status:** 📋 Planned — spun out of
  [US-012](../sprint/current/done/US-012-email-reports.md) on 2026-07-28.
  US-012's decision 10 deferred the account tier explicitly: *"Account does not
  mean anything yet: there is one seeded user and no login… Tiers 2 and 3 stay
  env-only."* [US-021](../sprint/current/done/US-021-signup-auth.md) shipped
  2026-07-24 and that premise expired — accounts are real, logged in, and their
  email is a verified mailbox. Nothing picked the deferral back up.
- **Priority:** P3
- **Estimate:** ~half a day (migration + prefs on the account route + a Settings
  section + tests)
- **Depends on:** US-012 (the chain), US-021 (accounts that mean something)

## What exists today

`prefsFor` (`server/src/notify.js:111`) resolves one run's recipients down a
three-step chain, and only the first step is editable by anyone:

| tier | source | who can change it |
|---|---|---|
| 1 | `projects.notify_emails` / `projects.notify` | any user, in `NotifyPrefs.jsx` |
| 2 | `NOTIFY_EMAILS` / `NOTIFY_MODE` env | the operator, with a redeploy |
| 3 | the test owner's `users.email` | nobody |

Tier 2 is at the wrong level for a shared box. One env list mails *every*
project's failures to the same people, which is right for a single-tenant
self-host and wrong the moment US-021's second user signs up: a person who owns
tests in five projects has to set the same list five times, and the fallback
that would have saved them belongs to the instance rather than to them.

Tier 3 is a mailbox nobody chose. It is the account email — fine as a last
resort, except that on an auth-off self-host `db.js:106` seeds that row from
`OPERATOR_EMAIL`, which defaults to `operator@qassist.local`
(`config.js:262`) — **an address that cannot receive mail**. With no project
recipients and no `NOTIFY_EMAILS`, the send resolves there and silently goes
nowhere. US-012 flagged exactly this and said "making it settable is US-021's";
US-021 shipped without it.

## The decision this story has to make

Where the account tier sits, and it is not obvious:

**Recommended: project → account → env → `users.email`.** A user's own
preference beats the instance default but loses to a project that has stated
one, because a project list is the more specific answer to "who cares about
*this* failure". `NOTIFY_EMAILS` keeps its meaning as the instance default for
accounts that have set nothing, so no existing deployment changes behaviour.

The alternative — account above project — makes a personal setting override a
team one, which is how somebody stops receiving mail about the checkout suite
they own by editing a field that says nothing about checkout.

Mode follows recipients down the same chain. Keep US-012's not-null-with-a-
default shape at the project level; the account row needs a real "unset", so
that column *is* nullable and the null is what falls through.

## Details

- `017_account_notify.sql`: `users.notify text` (nullable, checked against the
  same values as `projects.notify`) and `users.notify_emails text[]`. Both
  inert on the day they land — a null and an empty array resolve to exactly
  today's chain.
- `prefsFor` gains one join it already half has: the query at `notify.js:113`
  already `left join users u on u.id = t.user_id` for `owner_email`, so this is
  two more columns on a join that exists, not a second query.
- Reuse `normalizeEmails` from `notify.js:34` for validation — the account list
  and the project list must not disagree about what an address is.
- Read/write on the account route, alongside the stored key. Not on
  `POST /api/auth/*` — signup names a person, prefs come after, same reasoning
  US-012 used to keep prefs off `POST /api/projects`.
- Frontend: a fourth section in the Settings dialog (`App.jsx:262`), beside
  `OpenaiKey`, `Billing` and `ApiKeys`. `NotifyPrefs.jsx` is project-scoped and
  stays that way; if its fields can be reused, reuse them — two dialogs that
  disagree about what a recipient list looks like is the bug this avoids.
- **`OPERATOR_EMAIL`'s unroutable default is in scope.** Either the seeded row
  becomes editable through the same surface (it is a `users` row like any
  other, so it already is once the section exists), or an instance with no
  routable recipient logs that it resolved to a dead address instead of
  reporting a successful send. Do the first; the second is the fallback if the
  seeded row turns out to need special handling.
- Suppression is unchanged and still wins over everything: an unsubscribe is
  instance-wide (`email_suppressions`), and an account list must not be a way
  back into a mailbox that opted out.

## Acceptance criteria

- [ ] With no account prefs set, every existing resolution is byte-for-byte
      today's — project list, else `NOTIFY_EMAILS`, else the owner's email
- [ ] An account list is used when the run's project has none, and is *not*
      used when the project has one
- [ ] An account mode of `never` silences that owner's runs in projects that
      inherit their mode, and does not touch a project that set its own
- [ ] A suppressed address stays suppressed however it entered the chain
- [ ] Two users on one instance get different recipients for runs in projects
      they each own — the case env vars cannot express
- [ ] An instance whose only recipient would be `operator@qassist.local` is
      either fixable through Settings or says so rather than reporting a send
- [ ] `cd server && npm test` covers each rung of the chain and the fallthrough
      between them; migration 017 applies against real Postgres

## Notes

- **Digest mode is still out.** US-012 parked it as "the answer to volume" and
  nothing here changes that; a per-account digest is the obvious later home for
  it, but it is a sender change, not a prefs change, and does not belong in
  this story.
- Not correctness-critical. It is preference resolution, not secret handling —
  the mail path's sensitive parts (unsubscribe signing, idempotent send) are
  untouched.
