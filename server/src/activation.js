// @ts-check
// The activation window (US-054). A subscription means "you may run once this
// instance has room for you", not "you may run now". A real Chromium needs a
// real box, and the box is sized by the operator's hand, not by demand.
//
// So there are two facts and one rule. `subscriptions.activation_requested_at`
// is when the promise was made (Stripe's clock, stamped once);
// `users.activated_at` is when the operator kept it (their hand, never a
// webhook's). The rule is that a paid account with the second still null waits,
// and every path that starts a run tells it so.
//
// This file imports from billing.js and billing.js imports nothing from here —
// the webhook's side of the story is wired in routes/billing.js, which already
// has both. Keeping the arrow one-way is what stops "who owns entitlement"
// becoming a question.
//
// Correctness-critical (backlog/correctness-critical.md): pinned assertion-first
// in activation-gate.test.js, with the OFF path in billing-gate.test.js.
import { db } from './db.js';
import { mailEnabled, sendMail } from './mail.js';
import { renderEmail, button, facts, note, paragraph, pre } from './mailTemplate.js';
import { ACTIVATION_SLA_HOURS, OPERATOR_EMAIL, PUBLIC_BASE_URL } from './config.js';
import { billingEnabled, billingStateFor, entitledFrom, isExempt, isEntitlingStatus } from './billing.js';

const HOUR_MS = 3600_000;

/**
 * The whole decision, off the clock and off the database.
 *
 * `slaHours` falsy is the OFF path, and it returns `activated: true` rather
 * than some third "not applicable" state. That is deliberate and load-bearing:
 * every call site can then ask the same question with no `if (enabled)` around
 * it, and the story's second failure mode — one of the seven run-start paths
 * missing the gate — has nowhere to hide. It is also what lets an operator who
 * has bought a bigger box delete ACTIVATION_SLA_HOURS from .env and release
 * everyone mid-window, instead of activating a backlog by hand.
 *
 * @param {{ activated_at?: Date|string|null, activation_requested_at?: Date|string|null } | null} row
 * @param {{ slaHours?: number|null, now?: number }} [opts]
 * @returns {{ on: boolean, activated: boolean, pending: boolean, deadline: Date|null, overdue: boolean }}
 */
export function activationStateFrom(row, { slaHours, now = Date.now() } = {}) {
  const hours = Number(slaHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return { on: false, activated: true, pending: false, deadline: null, overdue: false };
  }
  const activated = !!row?.activated_at;
  const requested = row?.activation_requested_at ? new Date(row.activation_requested_at) : null;
  const deadline =
    requested && Number.isFinite(requested.getTime())
      ? new Date(requested.getTime() + hours * HOUR_MS)
      : null;
  const pending = !activated;
  return {
    on: true,
    activated,
    pending,
    deadline,
    // An overdue account is still walled — nothing here auto-activates. Being
    // late is a fact for the operator's list and their inbox, not a licence to
    // hand someone a box nobody upgraded.
    overdue: pending && !!deadline && deadline.getTime() <= now,
  };
}

/** Whether this instance makes accounts wait at all. Billing off ⇒ off. */
export function activationEnabled() {
  return billingEnabled() && ACTIVATION_SLA_HOURS > 0;
}

/**
 * The window's verdict for one already-loaded billing state, so the gate reads
 * the database once. Exempt implies activated: BILLING_EXEMPT_EMAILS defaults
 * to OPERATOR_EMAIL, and an operator walled out of the box they are resizing
 * cannot smoke-test the thing they were asked to activate.
 * @param {{ exempt?: boolean, activated_at?: Date|string|null,
 *           activation_requested_at?: Date|string|null }} state
 * @param {{ now?: number }} [opts]
 */
export function activationStateFor(state, { now = Date.now() } = {}) {
  const on = activationEnabled();
  if (!on || state.exempt) {
    return { on, activated: true, pending: false, deadline: null, overdue: false };
  }
  return activationStateFrom(state, { slaHours: ACTIVATION_SLA_HOURS, now });
}

/**
 * May this user start a run, and if not, which refusal? One billing read
 * answers both gates, which is what makes it impossible for a caller to have
 * the entitlement check and miss the activation one. Free instances never
 * reach the database at all.
 * `reason` is set only when `allow` is false. One optional-field shape rather
 * than a discriminated union because this project checks JSDoc with
 * `strict: false` (jsconfig.json), under which tsc does not narrow a union on a
 * boolean literal — the union would type-check worse, not better.
 * @param {string|null} userId
 * @returns {Promise<{ allow: boolean, reason?: 'billing'|'activation',
 *                     state?: any, activation?: any }>}
 */
export async function runGateFor(userId) {
  if (!billingEnabled()) return { allow: true };
  const state = await billingStateFor(userId);
  // Entitlement first: an account that has not paid is told to pay, not to
  // wait for capacity it never bought.
  if (!state.entitled) return { allow: false, reason: 'billing', state };
  const activation = activationStateFor(state);
  if (activation.pending) return { allow: false, reason: 'activation', state, activation };
  return { allow: true };
}

/**
 * What to put in `Retry-After`. Whole seconds to the deadline, floored at a
 * minute so a runner that retries at the exact deadline does not hammer, and
 * the full window when there is no deadline to count to.
 * @param {{ deadline: Date|null }} activation
 * @param {number} [now]
 */
export function retryAfterSeconds(activation, now = Date.now()) {
  if (!activation.deadline) return ACTIVATION_SLA_HOURS * 3600;
  return Math.max(60, Math.ceil((activation.deadline.getTime() - now) / 1000));
}

// --- the clock: stamped once, by the entitling event -------------------------

/**
 * Start the window, if it has not started. Its own statement rather than a
 * `coalesce` inside writeSubscription, because the rowCount is the signal:
 * checkout.session.completed and customer.subscription.created routinely share
 * a `created` second, so "the value equals this event's timestamp" would fire
 * the operator's mail twice for one customer. `where … is null` fires once.
 * @param {string} userId
 * @param {Date} at the Stripe event's own `created`
 * @returns {Promise<boolean>} true only for the first entitling event
 */
export async function stampActivationRequest(userId, at) {
  const { rowCount } = await db().query(
    `update subscriptions set activation_requested_at = $2
      where user_id = $1 and activation_requested_at is null`,
    [userId, at]
  );
  return rowCount === 1;
}

/**
 * The webhook's half: record when this account became entitled, and — once —
 * tell the operator they owe it capacity by a stated time.
 *
 * The stamp is unconditional and the mail is not. Recording is a write, not the
 * "no column read" the off path promises, and it means an instance that turns
 * the window on later finds a correct clock rather than a null it has to guess
 * at. Nothing is mailed while the window is off, because there is no promise.
 * @param {{ userId: string, status: string, at: Date } | null} applied
 *        what applySubscriptionEvent actually wrote, or null if it wrote nothing
 */
export async function noteSubscriptionEvent(applied) {
  if (!applied || !isEntitlingStatus(applied.status)) return;
  if (!(await stampActivationRequest(applied.userId, applied.at))) return;
  if (!activationEnabled()) return;
  await mailOperatorWaiting(applied.userId, applied.at, applied.status);
}

// --- the two mails -----------------------------------------------------------

/** Never let a failed send fail the webhook: Stripe would retry an event we
 *  have already applied, and the ledger would drop it silently. */
async function trySend(msg) {
  if (!mailEnabled()) return;
  try {
    await sendMail(msg);
  } catch (err) {
    console.error(`activation: mail to ${msg.to} failed:`, err);
  }
}

const appLink = () => PUBLIC_BASE_URL || 'your QAssist instance';

/** The operator's hour, bought: who is waiting, on what, and by when. */
async function mailOperatorWaiting(userId, at, status) {
  const { rows } = await db().query('select email from users where id = $1', [userId]);
  const email = rows[0]?.email;
  if (!email) return;
  const deadline = new Date(at.getTime() + ACTIVATION_SLA_HOURS * HOUR_MS);
  const commands =
    `npm run activate                 # everyone still waiting\n` + `npm run activate -- ${email}`;
  const lever =
    'If the window cannot be met, the honest lever is Stripe — refund or cancel. ' +
    'Activating an account on a box nobody upgraded is the failure this window exists to prevent.';
  await trySend({
    to: OPERATOR_EMAIL,
    subject: `QAssist: ${email} is waiting for capacity`,
    text:
      `${email} subscribed (${status}) and is in the activation window.\n\n` +
      `Ready by:  ${deadline.toUTCString()}  (${ACTIVATION_SLA_HOURS}h)\n\n` +
      `Add the capacity, then activate the account:\n\n` +
      `  npm run activate                 # everyone still waiting\n` +
      `  npm run activate -- ${email}\n\n` +
      `If the window cannot be met, the honest lever is Stripe — refund or\n` +
      `cancel. Activating an account on a box nobody upgraded is the failure\n` +
      `this window exists to prevent.\n`,
    html: renderEmail({
      heading: `${email} is waiting for capacity`,
      badge: { label: 'ACTIVATION DUE', tone: 'warn' },
      preheader: `Ready by ${deadline.toUTCString()} (${ACTIVATION_SLA_HOURS}h).`,
      blocks: [
        paragraph(`${email} subscribed (${status}) and is in the activation window.`),
        facts([
          ['Ready by', deadline.toUTCString()],
          ['Window', `${ACTIVATION_SLA_HOURS}h`],
        ]),
        paragraph('Add the capacity, then activate the account:'),
        pre(commands),
        note(lever),
      ],
    }),
  });
}

/** The customer's promise, kept. */
async function mailCustomerReady(email) {
  const link = appLink();
  await trySend({
    to: email,
    subject: 'Your QAssist workspace is ready',
    text:
      `Your account has capacity and your first run can start now.\n\n` +
      `${link}\n\n` +
      `Thanks for waiting.\n`,
    html: renderEmail({
      heading: 'Your workspace is ready',
      badge: { label: 'ACTIVATED', tone: 'ok' },
      preheader: 'Your account has capacity — your first run can start now.',
      blocks: [
        paragraph('Your account has capacity and your first run can start now.'),
        PUBLIC_BASE_URL ? button('Start a run', PUBLIC_BASE_URL) : paragraph(link),
        note('Thanks for waiting.'),
      ],
    }),
  });
}

// --- the operator's script (scripts/activate.mjs is a CLI over these) --------

/**
 * Everyone entitled and still waiting, longest wait first — the order the
 * operator should work in. Exempt accounts are not listed: they were never
 * walled, so they are not waiting for anything.
 * @param {{ now?: number }} [opts]
 */
export async function pendingAccounts({ now = Date.now() } = {}) {
  if (!db()) return [];
  const { rows } = await db().query(
    `select u.id as user_id, u.email, u.activated_at,
            s.status, s.current_period_end, s.activation_requested_at
       from users u join subscriptions s on s.user_id = u.id
      where u.activated_at is null`
  );
  return rows
    .filter((row) => !isExempt(row.email) && entitledFrom(row, { now }))
    .map((row) => {
      const state = activationStateFrom(row, { slaHours: ACTIVATION_SLA_HOURS, now });
      return {
        user_id: row.user_id,
        email: row.email,
        status: row.status,
        requested_at: row.activation_requested_at ? new Date(row.activation_requested_at) : null,
        deadline: state.deadline,
        overdue: state.overdue,
      };
    })
    .sort((a, b) => {
      // Undated first: a promise with no clock on it is the one most likely to
      // have been forgotten.
      const at = a.requested_at ? a.requested_at.getTime() : -Infinity;
      const bt = b.requested_at ? b.requested_at.getTime() : -Infinity;
      return at - bt || a.email.localeCompare(b.email);
    });
}

/**
 * Give one account its capacity. The whole address, case-folded and trimmed,
 * matched with `=` — no LIKE, no prefix, no "did you mean". Activating the
 * wrong account cannot be undone by this file (nothing here ever clears
 * activated_at), so a near miss must be a refusal rather than a guess.
 *
 * Deliberately no entitlement precondition: activating someone who has not paid
 * changes nothing (the 402 still refuses them), while requiring payment here
 * would deadlock the race where the operator acts before the webhook lands.
 * @param {string} rawEmail
 * @returns {Promise<{ ok: false, reason: 'not-found' } |
 *                   { ok: true, already: boolean, user: { id: string, email: string },
 *                     activated_at: Date }>}
 */
export async function activateByEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'not-found' };
  const { rows } = await db().query(
    'select id, email, activated_at from users where lower(email) = $1',
    [email]
  );
  if (rows.length !== 1) return { ok: false, reason: 'not-found' };
  const user = { id: rows[0].id, email: rows[0].email };
  if (rows[0].activated_at) return { ok: true, already: true, user, activated_at: rows[0].activated_at };

  // `and activated_at is null` so a second caller cannot redate the moment this
  // account was given room, and so nobody is told twice.
  const { rows: updated } = await db().query(
    'update users set activated_at = now() where id = $1 and activated_at is null returning activated_at',
    [user.id]
  );
  if (!updated.length) {
    const { rows: fresh } = await db().query('select activated_at from users where id = $1', [user.id]);
    return { ok: true, already: true, user, activated_at: fresh[0].activated_at };
  }
  await mailCustomerReady(user.email);
  return { ok: true, already: false, user, activated_at: updated[0].activated_at };
}
