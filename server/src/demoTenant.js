// @ts-check
// Demo-sandbox tenant provisioning (US-036). On an AUTH_MODE=demo deployment a
// visitor with no session is minted a fresh, short-lived `users` row and seeded
// with a fixed fake dataset owned entirely by them. Isolation is free: every
// table scopes by user_id, so a tenant only ever sees and mutates its own rows.
// The reaper (US-036 step 4) later deletes the user past demo_expires_at.
//
// Seed is rows, not files: it clones a fixed dataset (a project + module, a few
// tests, a suite, a schedule, some finished runs so History isn't empty) but
// copies no artifacts — recordings/PDFs stay shared read-only fixtures under
// demo/, referenced by the replay interceptor. The dataset lives here as a JS
// structure rather than a templated seed.sql: the rows cross-reference through
// generated UUIDs, which a single parameterized statement can't thread cleanly
// and pg-mem (where the provision+seed test runs) won't execute as a modifying
// CTE. Sequential parameterized inserts are simple and testable on both.
import crypto from 'node:crypto';
import { db } from './db.js';
import { DEMO_TTL_MS } from './config.js';

// Two seed tests mirror the checked-in replay fixtures exactly (goal + start_url
// match demo/<slug>/meta.json) so the run interceptor can pick the right clip;
// the rest fall back to a default. Keep these in sync with the fixtures.
const FIXTURE_REGISTER = {
  name: 'Register an account',
  goal: 'register account',
  start_url: 'https://try.discourse.org/',
};
const FIXTURE_DISCOUNT = {
  name: 'Checkout discount code',
  goal:
    'Add any item to the cart, apply the promo code SAVE20 at checkout, and ' +
    'confirm the 20% discount is deducted from the order total.',
  start_url: 'https://shop.example/',
};

// Two more tests with no matching fixture — they exercise the interceptor's
// default and give the lists more than the two fixtures' worth of content.
const TEST_HOMEPAGE = {
  name: 'Homepage loads without errors',
  goal: 'Open the storefront homepage and confirm it renders with no console errors.',
  start_url: 'https://shop.example/',
};
const TEST_SEARCH = {
  name: 'Product search returns results',
  goal: "Search for 'shoes' and confirm at least one product is listed.",
  start_url: 'https://shop.example/',
};

/**
 * Seed a freshly-minted tenant with the fixed fake dataset, all owned by
 * userId. Runs on the caller's transaction client so provisioning is atomic.
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {number} now epoch ms — anchors run/schedule timestamps
 */
async function seedTenant(client, userId, now) {
  const one = async (/** @type {string} */ sql, /** @type {any[]} */ params) =>
    (await client.query(sql, params)).rows[0];

  const project = await one(
    'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id',
    [userId, 'Acme Storefront', 'acme-storefront']
  );
  const module = await one(
    'insert into modules (project_id, name, slug) values ($1, $2, $3) returning id',
    [project.id, 'Checkout', 'checkout']
  );

  /**
   * @param {{ name: string, goal: string, start_url: string }} t
   * @param {{ projectId?: string|null, moduleId?: string|null }} [group]
   */
  const insertTest = async (t, { projectId = null, moduleId = null } = {}) => {
    const row = await one(
      `insert into tests (user_id, name, goal, start_url, project_id, module_id)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [userId, t.name, t.goal, t.start_url, projectId, moduleId]
    );
    return { id: row.id, goal: t.goal, start_url: t.start_url };
  };

  const register = await insertTest(FIXTURE_REGISTER, { projectId: project.id });
  const discount = await insertTest(FIXTURE_DISCOUNT, {
    projectId: project.id,
    moduleId: module.id,
  });
  const homepage = await insertTest(TEST_HOMEPAGE, { projectId: project.id });
  await insertTest(TEST_SEARCH); // ungrouped, exercises the "Ungrouped" bucket

  const suite = await one(
    'insert into suites (user_id, project_id, name) values ($1, $2, $3) returning id',
    [userId, project.id, 'Smoke suite']
  );
  for (const [pos, testId] of [register.id, discount.id].entries()) {
    await client.query(
      'insert into suite_tests (suite_id, test_id, position) values ($1, $2, $3)',
      [suite.id, testId, pos]
    );
  }

  // Enabled but next_run_at a day out: a tenant expires long before it fires, so
  // the scheduler never actually triggers a seeded schedule — it is here to
  // populate the Schedules view, not to run.
  await client.query(
    `insert into schedules (user_id, suite_id, kind, hour, enabled, next_run_at)
     values ($1, $2, 'daily', 9, true, $3)`,
    [userId, suite.id, new Date(now + 24 * 60 * 60 * 1000)]
  );

  // Finished runs so History and the pass-rate aren't empty. Terminal status,
  // no artifacts (report_status 'none', has_recording false): the seed copies no
  // files, so these history rows offer no PDF/recording link to 404 on. The live
  // replay is where a recording comes from.
  /** @type {Array<{ test: any, ok: boolean, ageHrs: number }>} */
  const history = [
    { test: register, ok: true, ageHrs: 2 },
    { test: discount, ok: false, ageHrs: 5 },
    { test: homepage, ok: true, ageHrs: 26 },
    { test: register, ok: true, ageHrs: 27 },
    { test: discount, ok: false, ageHrs: 50 },
  ];
  for (const { test, ok, ageHrs } of history) {
    const created = new Date(now - ageHrs * 60 * 60 * 1000);
    const finished = new Date(created.getTime() + 90 * 1000);
    await client.query(
      `insert into runs
         (id, user_id, test_id, trigger, goal, start_url, max_steps,
          status, success, final_result, steps_count,
          created_at, started_at, finished_at)
       values ($1, $2, $3, 'ui', $4, $5, 60,
          $6, $7, $8, $9, $10, $10, $11)`,
      [
        crypto.randomUUID(),
        userId,
        test.id,
        test.goal,
        test.start_url,
        ok ? 'passed' : 'failed',
        ok,
        ok ? 'Goal met.' : 'The discount was accepted but never deducted from the total.',
        ok ? 7 : 9,
        created,
        finished,
      ]
    );
  }
}

/**
 * Mint an anonymous demo tenant and seed it, atomically. Returns the new user's
 * id and when the reaper may delete it. The synthetic email satisfies the NOT
 * NULL UNIQUE constraint and is a reserved, non-deliverable address.
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ userId: string, expiresAt: Date }>}
 */
export async function provisionTenant({ now = Date.now() } = {}) {
  const pool = db();
  if (!pool) throw new Error('demo provisioning requires the control plane');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const email = `demo-${crypto.randomBytes(9).toString('hex')}@demo.invalid`;
    const expiresAt = new Date(now + DEMO_TTL_MS);
    const { rows } = await client.query(
      'insert into users (email, demo_expires_at) values ($1, $2) returning id',
      [email, expiresAt]
    );
    const userId = rows[0].id;
    await seedTenant(client, userId, now);
    await client.query('commit');
    return { userId, expiresAt };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * How many demo tenants are currently live (unexpired). The cap check (US-036
 * step 5) reads this; exported now so provisioning has a single source.
 * @param {{ now?: number }} [opts]
 */
export async function liveTenantCount({ now = Date.now() } = {}) {
  const { rows } = await db().query(
    'select count(*)::int as n from users where demo_expires_at > $1',
    [new Date(now)]
  );
  return rows[0].n;
}
