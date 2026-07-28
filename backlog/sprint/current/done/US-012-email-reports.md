# US-012 — Failure email notifications

**As a** user, **I want** an email when a test run fails, **so that** I hear about breakage without checking a dashboard.

- **Status:** ✅ Done (2026-07-23) — schema, sender, prefs API, unsubscribe,
  prefs dialog, docs. Unproven against Resend itself until US-007 verifies the
  sender domain; see "Still to do".
- **Priority:** P1 (current sprint — on-failure notification only)
- **Estimate:** ~1 day
- **Depends on:** US-009 (Postgres for recipients/prefs); pairs with US-010

**current-sprint scope:** on-failure email only (the default). "Always"/"never"
prefs are cheap to include; digest mode stays out of current sprint.

## Details

- Notification prefs (mode + recipient list) per **project** — see decision 1.
- Send on run completion: verdict, goal, duration, final-result text, link to
  (or attachment of) the PDF report. Attachment is easy — the PDF is
  single-page and small.
- Provider: **Resend** (decided 2026-07-22) — good free tier, simple API, and
  US-021's magic-link auth reuses the same account. Set up the qassist.run
  sender domain (SPF/DKIM DNS records) alongside US-007's DNS work so
  propagation is done before this story starts.
- Digest mode (daily summary) = later nice-to-have.

## Design decisions (2026-07-23)

1. **Prefs belong to the project, not the test.** `001_init.sql` put `notify`
   and `notify_emails` on `tests`, written before projects existed and never
   read by any code. The level is wrong for the same reason US-010 found the
   schedule's was: a recipient list is something a person owns — "mail the
   checkout team when checkout breaks" — while a per-test list means editing
   twenty rows to add one colleague, and keeping the twenty in sync by hand.
   `004_notifications.sql` drops the two columns and adds them to `projects`.

   Both levels of fallback are env, so an instance can be useful before anyone
   opens the UI:

   | what | where it comes from |
   |---|---|
   | mode | `projects.notify` (not null, default `failure`); a test in no project takes `NOTIFY_MODE` |
   | recipients | `projects.notify_emails`, else `NOTIFY_EMAILS`, else the owner's account email |

   The mode is not-null-with-a-default rather than nullable-means-inherit: two
   kinds of "unset" would resolve to the same env value anyway, and a mode you
   can read off the row is one you can reason about.

2. **The notification is per run.** Every finished run decides for itself
   whether to mail; there is no rollup for a suite, module or project trigger
   that started ten of them. `notifications` from 001 already has that shape —
   one row per `(run_id, recipient)`, which is also what makes a retry
   harmless. A digest is the answer to volume, and it stays out of current sprint.

3. **Ad-hoc runs never mail.** A run with no `test_id` was started from the Run
   view and is being watched live; mailing its result is noise, and it has no
   project to take a recipient list from either.

4. **`failure` means "anything that is not a pass"** — `failed`, `error`, and
   the unjudged `completed`. A run that ended without a verdict is exactly as
   much of a reason to look as one that failed, and treating it as silence is
   how a broken agent stays invisible.

5. **Attachment first, link second.** The PDF is a single small page, so it is
   attached outright; the link is added only when `PUBLIC_BASE_URL` is set
   (US-007), because until then it would be an address the recipient cannot
   reach. That means the mail has to wait for the renderer: `maybeNotify` in
   `runs.js` fires when the run has finished *and* its report is no longer
   `generating`, and both the child-close and report-close paths call it, since
   they complete in either order.

6. **Unsubscribe is instance-wide and signed.** The link carries an HMAC over
   the lowercased address (`NOTIFY_SECRET`, falling back to the API token so
   links survive a restart), and `GET /api/notifications/unsubscribe` is the
   one route in the app with no bearer token — the person clicking it is a
   colleague who was mailed a report, and asking them for the instance's API
   token to stop receiving mail means nobody ever stops receiving mail. The
   signature authorises exactly one thing: suppressing that address.

   Suppression is by address rather than by project, so being added to a second
   project cannot silently re-subscribe someone. It is also listable and
   deletable through the token-guarded API, because otherwise an accidental
   click is undoable only in SQL, and mail that quietly stops is worse than
   mail that stops loudly.

7. **Env-gated, like billing.** No `RESEND_API_KEY` or no `MAIL_FROM` = the
   feature is off: prefs are still stored and editable, nothing is sent. A
   self-hoster who wants email brings a Resend key, exactly as they bring an
   OpenAI one.

8. **No SDK.** The send is one `fetch` to Resend's REST API — a dependency
   wrapping that would be more code to audit than the code it replaces.
   `RESEND_API_URL` is overridable so the tests can point it at a loopback
   server and inspect the request that would have gone out, attachment and all,
   instead of stubbing `fetch`.

9. **The link is the app root plus a run id, for now** — History has no
   per-run URL to link to. Spun out as **US-030** (run permalink); when it
   lands, `compose()` in `notify.js` points at `/runs/<id>` instead.

10. **Account-level prefs wait for US-021.** The recipient chain already has an
    account tier — `notify.js` joins `users.email` as the last fallback, and
    `db.js` seeds that row from `OPERATOR_EMAIL` — so the question is only
    whether the UI can edit it, and the answer for the current sprint is no. "Account"
    does not mean anything yet: there is one seeded user and no login, so an
    account-settings surface today would edit the same operator row that holds
    the BYOK key and will receive magic-links, before the story that gives it
    an owner. Tiers 2 and 3 stay env-only, which was decision 1's intent.

    **Picked up 2026-07-28 as
    [US-060](../../../unscheduled/US-060-account-level-notification-prefs.md)** —
    US-021 shipped, so "account" means something now and the deferral's premise
    is gone. The `OPERATOR_EMAIL` note below goes with it.

    Left behind for whoever picks this up: `OPERATOR_EMAIL` defaults to
    `operator@qassist.local` (`config.js:68`), so on an instance with no
    project recipients and no `NOTIFY_EMAILS` the send resolves to an address
    that cannot receive. Documenting the variable is the current-sprint fix; making
    it settable is US-021's.

## Progress (2026-07-23)

Backend shipped: `004_notifications.sql` (drop the dead test columns, prefs on
`projects`, `email_suppressions`), `src/mail.js` (transport only),
`src/notify.js` (who/whether/what, plus the unsubscribe signature),
`routes/notifications.js`, prefs on `PUT /api/projects/:project` and the
`maybeNotify` hook in `runs.js`. Prefs are deliberately not settable on
`POST /api/projects` — a create names a project, and the UI edits prefs after.

Verification: 97 server tests (`notify.test.js` among them), `npm run check`
clean, and migration 004 applies to real Postgres (`scheduler-postgres.test.js`
runs the migrations there). The mail tests run a real HTTP server on a loopback
port as the provider, so what they assert is the actual outbound request.

**Two more ways pg-mem is not Postgres**, both found by this story and both
now written into the code that depends on them:

- `insert … on conflict (a, b) do nothing … returning` hands back the
  *conflicting* row under pg-mem as though it had inserted it. The idempotent
  send would therefore have looked correct in every test while mailing twice on
  a retry. The claim is an `insert … select … where not exists … returning`
  instead — no row on a duplicate under either engine, with the unique key left
  as the durable backstop.
- pg-mem keeps a column's inline `check` after the column is dropped, and then
  fails every insert against the table, having nothing left to read. 004 drops
  the constraint explicitly first, under both engines' generated names
  (`tests_notify_check` on Postgres, `tests_constraint_1` on pg-mem) with
  `if exists` making each line a no-op on the other engine.

Also: an uncast `default '{}'` on a `text[]` comes back from pg-mem as the
string `"{}"`, so the API answers a different shape there than in production —
the column declares `default '{}'::text[]`.

UI shipped: `NotifyPrefs.jsx` — mode, recipients, and the unsubscribed
addresses in the list with a re-enable — opened from a `Bell` in the project
row's `.row-actions`, plus `mail` on `/api/health` and an Email row in
Settings. It is a modal off the list row rather than a card in the detail
pane: that is where `CiCommand` is already reached, and the two dialogs are
the same kind of thing — per-project settings that are not part of managing
modules.

**The row ran out of room**, which is this story's doing: notifications made a
fourth icon on every project row. Delete moved off the row and into the inline
editor (far left, away from Save, matching `.modal-foot .btn-danger`), so
projects are back to three actions and modules to two. `GroupEditor` is shared,
so both picked it up, and the pencil is now labelled Edit rather than Rename.

Docs done: the six variables in `.env.example` and the README config table,
an "Email notifications" section in the README API docs (prefs shape, the
fallback chain, the two suppression routes), and `db/README.md` corrected —
its `tests` row no longer claims the prefs, `projects` does, and the key
decision says why they moved. `health.mail` is covered from both sides:
`api.test.js` configures no provider and asserts `false`, `notify.test.js`
configures one and asserts `true`, and `node --test` gives each file its own
process. 98 server tests, `npm run check` clean.

## Still to do

- **A real send**, once US-007's DNS work verifies the qassist.run sender
  domain. Until then Resend only delivers to the account's own address. This
  does not block the story: criterion 1 is ticked against the stand-in
  provider and carries the caveat, because waiting on it would park a finished
  feature behind an unstarted one. **Owned by [US-007](US-007-https-reverse-proxy.md)
  since 2026-07-23** — the SPF/DKIM records are the same DNS visit as the A
  record, so the proof is an acceptance criterion there rather than this story
  coming back out of `done/`.

## Acceptance criteria

- [x] Failing scheduled run → email within minutes, with the report attached —
      covered end-to-end in `notify.test.js` against a stand-in provider;
      unproven against Resend itself until the sender domain is verified
- [x] on-failure-only default doesn't email on passes
- [x] Unsubscribe/prefs honored — suppression is checked on every send
- [x] The prefs are reachable from the UI — `NotifyPrefs.jsx`, opened from the
      project row; the dialog also says when the instance cannot send at all
