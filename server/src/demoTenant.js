// @ts-check
// Demo-sandbox tenant provisioning (US-036). On an AUTH_MODE=demo deployment a
// visitor with no session is minted a fresh, short-lived `users` row and seeded
// with a fixed fake dataset owned entirely by them. Isolation is free: every
// table scopes by user_id, so a tenant only ever sees and mutates its own rows.
// The reaper (US-036 step 4) later deletes the user past demo_expires_at.
//
// The dataset itself is `demoSeed.js` — it is the half that grows with every
// story that stores anything, and this file is the half that does not.
import crypto from 'node:crypto';
import { db } from './db.js';
import { DEMO_TTL_MS } from './config.js';
import { seedTenant } from './demoSeed.js';

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
