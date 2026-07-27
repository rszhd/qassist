// @ts-check
// US-058 — the operator's per-account concurrency lever.
//
// A script rather than a screen, for the same reason `activate` is one: this is
// a rationing decision made while sizing the box, so the operator already has a
// shell open — and an admin UI would be a new authenticated surface, and a role
// concept we do not have, for what is one UPDATE.
//
//   npm run concurrency                       # who has an override, and the default
//   npm run concurrency -- you@example.com 4  # give that account 4 concurrent runs
//   npm run concurrency -- you@example.com -  # clear it, back to the default
//
// On a deployed box, inside the app container (DEPLOY.md):
//
//   docker compose -p qassist -f docker-compose.yml -f docker-compose.prod.yml \
//     exec qassist npm --prefix /app/server run concurrency
//
// A write here reaches the running server on that account's NEXT SUBMIT — the
// run-start paths re-read their caller's override before admitting a run. No
// restart, which matters because a restart would kill every run in flight.
import pg from 'pg';
import { attachDb } from '../src/db.js';
import {
  listUserConcurrencyCaps,
  writeUserConcurrencyCap,
} from '../src/concurrency.js';
import { MAX_CONCURRENT, MAX_CONCURRENT_PER_USER } from '../src/config.js';

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

const instanceDefault =
  MAX_CONCURRENT_PER_USER == null ? 'unset (accounts are uncapped)' : String(MAX_CONCURRENT_PER_USER);

try {
  const [email, value] = process.argv.slice(2);

  if (!email) {
    const overridden = await listUserConcurrencyCaps();
    console.log(`Instance-wide MAX_CONCURRENT_PER_USER: ${instanceDefault}`);
    console.log(`Whole-box MAX_CONCURRENT_SESSIONS:     ${MAX_CONCURRENT}\n`);
    if (!overridden.length) {
      console.log('No account has an override — everyone is on the instance default.');
    } else {
      console.log(`${overridden.length} account(s) with an override:\n`);
      for (const u of overridden) console.log(`  ${u.email}  →  ${u.max_concurrent_runs}`);
    }
    console.log('\nSet one with:    npm run concurrency -- <email> <n>');
    console.log('Clear one with:  npm run concurrency -- <email> -');
  } else {
    if (value === undefined) {
      console.error('Give a number, or "-" to clear. E.g. npm run concurrency -- you@example.com 4');
      process.exit(1);
    }
    const clearing = value === '-';
    const cap = clearing ? null : Number(value);
    // The database refuses < 1 anyway (012's check). Saying so here is the
    // difference between an answer and a constraint-violation stack trace.
    if (!clearing && (!Number.isInteger(cap) || cap < 1)) {
      console.error(
        `"${value}" is not a cap. Use a whole number of 1 or more, or "-" to clear.\n` +
          'Zero would be an account suspension, not a capacity limit — that is not this lever.'
      );
      process.exit(1);
    }

    // Exact match only, and no suggestion: capping the wrong account is not
    // something this script can undo (activate.mjs takes the same line).
    const { rows } = await pool.query('select id, email from users where lower(email) = lower($1)', [
      String(email).trim(),
    ]);
    if (!rows.length) {
      console.error(`No account matches "${email}" exactly.`);
      process.exit(1);
    }

    await writeUserConcurrencyCap(rows[0].id, cap);
    if (clearing) {
      console.log(`Cleared ${rows[0].email}'s override — back to the instance default (${instanceDefault}).`);
    } else {
      console.log(`${rows[0].email} may now run ${cap} test(s) at once.`);
      // Accepted, not refused: the global gate wins either way, and a database
      // constraint cannot see an env var to reject it at write time.
      if (cap > MAX_CONCURRENT) {
        console.warn(
          `  note: the whole box only runs ${MAX_CONCURRENT} at once ` +
            `(MAX_CONCURRENT_SESSIONS), so anything above that never binds.`
        );
      }
    }
    console.log('Takes effect on their next submitted run — no restart needed.');
  }
} finally {
  await pool.end();
}
