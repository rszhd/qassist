# US-012 — Failure email notifications

**As a** user, **I want** an email when a test run fails, **so that** I hear about breakage without checking a dashboard.

- **Status:** 🚧 Backend done (2026-07-23) — schema, sender, prefs API,
  unsubscribe; the prefs UI is still to come
- **Priority:** P1 (Release 1 — on-failure notification only)
- **Estimate:** ~1 day
- **Depends on:** US-009 (Postgres for recipients/prefs); pairs with US-010

**Release-1 scope:** on-failure email only (the default). "Always"/"never"
prefs are cheap to include; digest mode stays out of Release 1.

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
   harmless. A digest is the answer to volume, and it stays out of Release 1.

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

## Progress (2026-07-23)

Backend shipped: `004_notifications.sql` (drop the dead test columns, prefs on
`projects`, `email_suppressions`), `src/mail.js` (transport only),
`src/notify.js` (who/whether/what, plus the unsubscribe signature),
`routes/notifications.js`, prefs on `PUT /api/projects/:project` and the
`maybeNotify` hook in `runs.js`. Prefs are deliberately not settable on
`POST /api/projects` — a create names a project, and the UI edits prefs after.

Verification: 97 server tests plus `notify.test.js`'s 14, `npm run check`
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

## Still to do

- **Prefs UI** — mode + recipients on the project. The Projects detail pane is
  the home; the existing row editor is an inline rename form, so this wants its
  own card or modal. `/api/health` should report `mail` alongside `agent_ready`
  so the UI can say plainly when email is not configured on this instance.
- **Docs** — `.env.example` (`RESEND_API_KEY`, `MAIL_FROM`, `NOTIFY_EMAILS`,
  `NOTIFY_MODE`, `NOTIFY_SECRET`), README's API section, and `db/README.md`,
  whose notification row still says the prefs live on `tests`.
- **A real send**, once US-007's DNS work verifies the qassist.run sender
  domain. Until then Resend only delivers to the account's own address.

## Acceptance criteria

- [x] Failing scheduled run → email within minutes, with the report attached —
      covered end-to-end in `notify.test.js` against a stand-in provider;
      unproven against Resend itself until the sender domain is verified
- [x] on-failure-only default doesn't email on passes
- [x] Unsubscribe/prefs honored — suppression is checked on every send
- [ ] The prefs are reachable from the UI
