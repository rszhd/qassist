// @ts-check
// US-054 — the operator's half of the activation window.
//
// A script rather than a screen, deliberately: the work this accompanies is
// resizing the server, so the operator is already on the box with a shell open.
// An admin UI would be a new authenticated surface for what is one UPDATE.
//
//   npm run activate                    # who is waiting, and how long they have left
//   npm run activate -- you@example.com # give that one account its capacity
//
// On a deployed box, inside the app container (DEPLOY.md):
//
//   docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
//     exec qassist npm --prefix /app/server run activate
//
// The logic lives in src/activation.js so what the tests pin is what this runs.
import pg from 'pg';
import { attachDb } from '../src/db.js';
import { pendingAccounts, activateByEmail, activationEnabled } from '../src/activation.js';
import { ACTIVATION_SLA_HOURS } from '../src/config.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — run this inside the app container.');
  process.exit(1);
}

// A plain pool, deliberately not initDb(): that also runs migrations and marks
// every in-flight run as errored, which is the app's job at boot and not a side
// effect a script the operator runs mid-day may have.
const pool = new pg.Pool({ connectionString: url });
attachDb(pool);

/** @param {Date|null} deadline */
function timeLeft(deadline) {
  if (!deadline) return 'no deadline';
  const ms = deadline.getTime() - Date.now();
  if (ms <= 0) return `OVERDUE by ${hours(-ms)}`;
  return `${hours(ms)} left`;
}

const hours = (ms) => {
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
};

try {
  if (!activationEnabled()) {
    // Not an error: it is the answer. Say which half is off so the operator
    // isn't left wondering whether they typed the address wrong.
    console.log(
      ACTIVATION_SLA_HOURS > 0
        ? 'Billing is not configured on this instance, so no account is ever walled.'
        : 'ACTIVATION_SLA_HOURS is unset — no account waits for capacity on this instance.'
    );
    console.log('Accounts run as soon as they are entitled. Nothing to activate.');
  }

  const email = process.argv[2];

  if (!email) {
    const waiting = await pendingAccounts();
    if (!waiting.length) {
      console.log('Nobody is waiting for capacity.');
    } else {
      console.log(`${waiting.length} account(s) waiting (SLA ${ACTIVATION_SLA_HOURS}h):\n`);
      for (const a of waiting) {
        const ready = a.deadline ? a.deadline.toUTCString() : '—';
        console.log(`  ${a.email}`);
        console.log(`    plan ${a.status}  ·  ready by ${ready}  ·  ${timeLeft(a.deadline)}`);
      }
      console.log('\nActivate one with:  npm run activate -- <email>');
    }
  } else {
    const result = await activateByEmail(email);
    if (!result.ok) {
      // No fuzzy match and no suggestion, on purpose: activating the wrong
      // account is not something this script can undo.
      console.error(`No account matches "${email}" exactly. Run with no argument to list who is waiting.`);
      process.exit(1);
    }
    if (result.already) {
      console.log(`${result.user.email} was already activated at ${new Date(result.activated_at).toUTCString()}.`);
    } else {
      console.log(`Activated ${result.user.email}. They have been emailed.`);
    }
  }
} finally {
  await pool.end();
}
