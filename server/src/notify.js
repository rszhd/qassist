// @ts-check
// Failure email (US-012). One finished run, one decision, one mail per
// recipient: who to tell comes from the run's project, whether to tell them
// from that project's mode, and the `notifications` table makes the send
// idempotent — the (run_id, recipient) unique key means a retry can never
// double-mail.
//
// Deliberately not notified: ad-hoc runs. A run with no saved test was started
// from the Run view and is being watched live; mailing its result would be
// noise, and it has no project to take a recipient list from either.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { mailEnabled, sendMail } from './mail.js';
import {
  ARTIFACTS_DIR,
  NOTIFY_EMAILS,
  NOTIFY_MODE,
  NOTIFY_SECRET,
  PUBLIC_BASE_URL,
} from './config.js';

export const NOTIFY_MODES = new Set(['failure', 'always', 'never']);

/**
 * Normalise a recipient list from an API caller: trimmed, lowercased, unique,
 * and each entry at least shaped like an address — a typo here fails silently
 * at send time otherwise, hours later and in a log nobody is reading.
 * @param {any} value
 * @returns {{ error: string } | { emails: string[] }}
 */
export function cleanEmails(value) {
  if (!Array.isArray(value)) return { error: 'notify_emails must be an array' };
  const emails = [];
  for (const raw of value) {
    const email = String(raw || '')
      .trim()
      .toLowerCase();
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) return { error: `not an email: ${raw}` };
    if (!emails.includes(email)) emails.push(email);
  }
  return { emails };
}

/**
 * An address's unsubscribe signature. Keyed on the address alone, so the link
 * in any mail unsubscribes the recipient everywhere on this instance.
 * @param {string} email
 */
export function unsubscribeToken(email) {
  return crypto
    .createHmac('sha256', NOTIFY_SECRET)
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

/**
 * @param {string} email
 * @param {string} token
 */
export function verifyUnsubscribe(email, token) {
  const expected = unsubscribeToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The link, or null when this instance has no public address to put in it. */
function unsubscribeUrl(email) {
  if (!PUBLIC_BASE_URL) return null;
  const q = new URLSearchParams({ email, t: unsubscribeToken(email) });
  return `${PUBLIC_BASE_URL}/api/notifications/unsubscribe?${q}`;
}

/** @param {string} email */
export async function suppress(email) {
  await db().query(
    'insert into email_suppressions (email) values ($1) on conflict (email) do nothing',
    [email.toLowerCase()]
  );
}

/**
 * Drop the addresses that have unsubscribed. Placeholders rather than
 * `= any($1)`: pg-mem (test harness) has no array parameter binding, and the
 * list is one project's recipients long.
 * @param {string[]} emails
 */
async function allowed(emails) {
  if (!emails.length) return [];
  const placeholders = emails.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db().query(
    `select email from email_suppressions where email in (${placeholders})`,
    emails
  );
  const out = new Set(rows.map((r) => r.email));
  return emails.filter((e) => !out.has(e));
}

/**
 * Who to mail about this run, and when. The project owns both — a test that
 * belongs to no project falls back to the instance's env settings, and an
 * empty recipient list falls through to NOTIFY_EMAILS and then to the owner's
 * account email (which only becomes a real mailbox with US-021's auth).
 * @param {{ test_id: string }} run
 */
async function prefsFor(run) {
  const { rows } = await db().query(
    `select t.name, p.notify, p.notify_emails, u.email as owner_email
       from tests t
       left join projects p on p.id = t.project_id
       left join users u on u.id = t.user_id
      where t.id = $1`,
    [run.test_id]
  );
  const row = rows[0];
  if (!row) return { name: null, mode: 'never', emails: [] };
  const configured = (row.notify_emails || []).filter(Boolean);
  const emails = configured.length
    ? configured
    : NOTIFY_EMAILS.length
      ? NOTIFY_EMAILS
      : [row.owner_email].filter(Boolean);
  return {
    name: row.name,
    mode: row.notify || NOTIFY_MODE,
    emails: [...new Set(emails.map((e) => String(e).trim().toLowerCase()))].filter(Boolean),
  };
}

const LABEL = {
  passed: 'PASSED',
  failed: 'FAILED',
  error: 'ERROR',
  completed: 'FINISHED',
  cancelled: 'STOPPED',
};

/**
 * The message body. Everything a person needs to decide whether to open the
 * report: verdict, what was asked, how long it took, and what the judge said.
 * @param {any} run
 * @param {string | null} name
 * @param {string} recipient
 */
function compose(run, name, recipient) {
  const res = run.result || {};
  const label = LABEL[run.status] || run.status.toUpperCase();
  const title = name || run.goal;
  const seconds =
    res.duration_seconds ??
    (run.startedAt && run.finishedAt ? Math.round((run.finishedAt - run.startedAt) / 1000) : null);
  const steps = res.steps ?? run.events.filter((e) => e.type === 'step').length;
  const unsubscribe = unsubscribeUrl(recipient);

  const lines = [
    `${label} — ${title}`,
    '',
    `Goal: ${run.goal}`,
    `URL: ${run.start_url}`,
    `Steps: ${steps}${seconds != null ? ` · Duration: ${seconds}s` : ''}`,
    '',
    res.final_result || res.message || '(no result text)',
    '',
    run.reportStatus === 'ready' ? 'The PDF report is attached.' : 'No report was produced.',
  ];
  if (PUBLIC_BASE_URL) lines.push(`Open this run: ${PUBLIC_BASE_URL}/runs/${run.id}`);
  if (unsubscribe) lines.push('', `Unsubscribe: ${unsubscribe}`);

  return {
    subject: `[QAssist] ${label} — ${title}`,
    text: lines.join('\n'),
    unsubscribeUrl: unsubscribe,
  };
}

/** The report PDF as a Resend attachment, when one was rendered. */
function attachmentFor(run) {
  const file = run.reportPath || path.join(ARTIFACTS_DIR, run.id, 'report.pdf');
  if (run.reportStatus !== 'ready' || !fs.existsSync(file)) return undefined;
  return [
    {
      filename: `qassist-report-${run.id.slice(0, 8)}.pdf`,
      content: fs.readFileSync(file).toString('base64'),
    },
  ];
}

/**
 * Mail a finished run's result to whoever asked for it. Safe to call more than
 * once per run: the delivery row is claimed with `on conflict do nothing`, and
 * only a claim that inserted actually sends.
 *
 * `failure` mode fires on anything that is not a pass — an `error` or an
 * unjudged `completed` run is exactly as much of a reason to look as a `failed`
 * one, and treating them as silence is how a broken agent stays invisible.
 *
 * @param {any} run
 * @returns {Promise<{ sent: number, failed: number, reason?: string }>}
 */
export async function notifyRunFinished(run) {
  const none = { sent: 0, failed: 0 };
  if (!db()) return { ...none, reason: 'no control plane' };
  if (!mailEnabled()) return { ...none, reason: 'mail not configured' };
  if (!run.test_id) return { ...none, reason: 'ad-hoc run' };

  const { name, mode, emails } = await prefsFor(run);
  if (mode === 'never') return { ...none, reason: 'notify=never' };
  if (mode === 'failure' && run.status === 'passed') return { ...none, reason: 'run passed' };
  // A stop is not a failure (US-047) — somebody ended this run on purpose and
  // already knows. Mailing it would make the lever that saves money cost an
  // alert. `always` still sends one: that mode means what it says.
  if (mode === 'failure' && run.status === 'cancelled') {
    return { ...none, reason: 'run cancelled' };
  }

  const recipients = await allowed(emails);
  if (!recipients.length) return { ...none, reason: 'no recipients' };

  const attachments = attachmentFor(run);
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    // Claimed with a not-exists guard rather than `on conflict do nothing
    // returning`: pg-mem (test harness) returns the conflicting row from that
    // form as though it had inserted it, so the guard would read as satisfied
    // in every test while doing nothing. This form returns no row on a
    // duplicate in both engines; the unique key stays as the durable backstop.
    const claim = await db().query(
      `insert into notifications (run_id, recipient)
       select $1, $2
        where not exists (select 1 from notifications where run_id = $1 and recipient = $2)
       returning id`,
      [run.id, recipient]
    );
    if (!claim.rowCount) continue; // already mailed (or in flight) for this run

    const msg = compose(run, name, recipient);
    try {
      await sendMail({ to: recipient, ...msg, attachments });
      await db().query("update notifications set status = 'sent', sent_at = now() where id = $1", [
        claim.rows[0].id,
      ]);
      sent++;
    } catch (err) {
      failed++;
      await db().query("update notifications set status = 'error', error = $2 where id = $1", [
        claim.rows[0].id,
        err.message,
      ]);
      console.error(`notify ${run.id.slice(0, 8)} → ${recipient} failed:`, err.message);
    }
  }
  return { sent, failed };
}
