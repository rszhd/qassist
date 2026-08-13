// @ts-check
// US-038 — give a staging deployment something to be staging *of*.
//
// The point is migrations. `db/migrations/*.sql` are applied at boot against
// whatever schema is already there, so the migration that is fine on an empty
// dev database and wrong on a populated one is only ever caught by a populated
// NON-production database. This puts rows in one.
//
// It reuses the demo sandbox's seed dataset (US-036) rather than growing a
// second one: the same project, module, four tests, suite, schedule and five
// finished runs — minus the TTL. The tenant's demo_expires_at stays null, and
// the reaper only ever selects rows where it `is not null`, so nothing here
// gets swept.
//
// Run it inside the staging app container, where DATABASE_URL already points at
// staging's own Postgres and nothing has to be exposed to reach it:
//
//   docker compose -p qassist-staging -f docker-compose.yml -f docker-compose.prod.yml \
//     exec qassist node /app/server/scripts/seed-staging.mjs you@example.com
//
// The email is required rather than defaulted: defaulting it to OPERATOR_EMAIL
// is what would make a mistyped `-p` seed production's operator account.
import pg from 'pg';
import { seedTenant } from '../src/demoSeed.js';

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('usage: node scripts/seed-staging.mjs <email>');
  console.error('  the account to own the seeded data (created if it does not exist)');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — run this inside the staging app container.');
  process.exit(1);
}

// Say where the rows are about to land before landing them. The failure mode
// worth catching is a right command against the wrong stack.
console.log(`seeding ${email} into ${url.replace(/\/\/[^@]*@/, '//')}`);

// A plain pool, deliberately not initDb(): that also runs migrations and marks
// every in-flight run as errored, which is the app's job at boot and not a
// side effect a seed script may have.
const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query('begin');

  let { rows } = await client.query('select id from users where email = $1', [email]);
  if (!rows.length) {
    ({ rows } = await client.query('insert into users (email) values ($1) returning id', [email]));
    console.log('created account');
  }
  const userId = rows[0].id;

  // Idempotent, and the guard that keeps this from scribbling over a real
  // account: an account that already owns anything is left exactly as it is.
  const { rows: owned } = await client.query(
    `select (select count(*) from tests where user_id = $1)
          + (select count(*) from projects where user_id = $1) as n`,
    [userId]
  );
  if (Number(owned[0].n) > 0) {
    await client.query('rollback');
    console.log(`${email} already owns tests or projects — nothing seeded.`);
    process.exit(0);
  }

  await seedTenant(client, userId, Date.now());
  await client.query('commit');
  console.log('seeded: 1 project, 1 module, 4 tests, 1 suite, 1 schedule, 5 finished runs');
} catch (err) {
  await client.query('rollback');
  console.error(err);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
