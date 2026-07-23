// @ts-check
// Schedules (US-010): CRUD over the schedules table. One flat resource with
// the target in the body rather than four nested routers under tests, modules,
// suites and projects — those would be the same handler written four times.
//
// Every write recomputes next_run_at from the preset, so the scheduler's claim
// marker can never disagree with the schedule the user is looking at.
import express from 'express';
import { db, getOperatorUserId, isUuid } from '../db.js';
import { validateSchedule, nextSlot } from '../schedule.js';
import { h, requireDb } from './helpers.js';

const COLS =
  'id, test_id, module_id, suite_id, project_id, kind, interval_hours, hour, minute, ' +
  'weekday, tz, enabled, next_run_at, last_run_at, created_at, updated_at';

/** The four things a schedule can point at, and the table each one lives in. */
const TARGETS = [
  ['test_id', 'tests'],
  ['module_id', 'modules'],
  ['suite_id', 'suites'],
  ['project_id', 'projects'],
];

// The list is read by a view that shows every schedule at once, whatever it
// points at, so it resolves the target here: without a name the UI would have
// to fetch all four collections and join them client-side to print one row.
// Which id column is set is already the target type (see decision 8), so the
// type is derived rather than stored.
const LIST_QUERY = `
  select ${COLS.split(', ')
    .map((c) => `s.${c}`)
    .join(', ')},
         case when s.test_id is not null then 'test'
              when s.module_id is not null then 'module'
              when s.suite_id is not null then 'suite'
              else 'project' end as target_type,
         coalesce(t.name, m.name, u.name, p.name) as target_name
    from schedules s
    left join tests t on t.id = s.test_id
    left join modules m on m.id = s.module_id
    left join suites u on u.id = s.suite_id
    left join projects p on p.id = s.project_id`;

/**
 * Pick the one target a write names and check it exists. The column is the
 * target type — the table's check constraint allows exactly one.
 * @param {any} body
 */
async function resolveTarget(body) {
  const named = TARGETS.filter(([column]) => body[column]);
  if (named.length !== 1) {
    return { error: `name exactly one of: ${TARGETS.map(([c]) => c).join(', ')}` };
  }
  const [column, table] = named[0];
  const id = String(body[column]);
  if (!isUuid(id)) return { error: `unknown ${column}` };
  const { rowCount } = await db().query(`select 1 from ${table} where id = $1`, [id]);
  if (!rowCount) return { error: `unknown ${column}` };
  return { column, id };
}

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function schedulesRouter({ checkToken }) {
  const r = express.Router();
  r.use(checkToken, requireDb);

  // Filters take the same target columns a write does, so the UI can ask
  // "what is scheduled on this suite?" without fetching the whole list.
  r.get(
    '/',
    h(async (req, res) => {
      const where = [];
      const params = [];
      for (const [column] of TARGETS) {
        const value = req.query[column];
        if (typeof value !== 'string' || !value) continue;
        if (!isUuid(value)) return res.status(400).json({ error: `invalid ${column}` });
        params.push(value);
        where.push(`s.${column} = $${params.length}`);
      }
      const { rows } = await db().query(
        `${LIST_QUERY}
         ${where.length ? `where ${where.join(' and ')}` : ''}
         order by s.next_run_at nulls last`,
        params
      );
      res.json({ schedules: rows });
    })
  );

  r.post(
    '/',
    h(async (req, res) => {
      const body = req.body || {};
      const target = await resolveTarget(body);
      if (target.error) return res.status(400).json({ error: target.error });
      const checked = validateSchedule(body);
      if (checked.error) return res.status(400).json({ error: checked.error });

      const schedule = checked.schedule;
      const enabled = body.enabled === undefined ? true : !!body.enabled;
      const { rows } = await db().query(
        `insert into schedules (user_id, ${target.column}, kind, interval_hours, hour,
                                minute, weekday, tz, enabled, next_run_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLS}`,
        [
          getOperatorUserId(),
          target.id,
          schedule.kind,
          schedule.interval_hours,
          schedule.hour,
          schedule.minute,
          schedule.weekday,
          schedule.tz,
          enabled,
          nextSlot(schedule),
        ]
      );
      res.status(201).json(rows[0]);
    })
  );

  // Partial update of the preset; the target is fixed for the schedule's life
  // (pointing an existing schedule at a different suite is a new schedule, and
  // saying so keeps last_run_at meaning what it says).
  r.put(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rows: existing } = await db().query(`select ${COLS} from schedules where id = $1`, [
        req.params.id,
      ]);
      if (!existing.length) return res.status(404).json({ error: 'not found' });

      const body = req.body || {};
      // Validate the merged result rather than the patch: changing only `kind`
      // still has to produce a schedule whose remaining fields make sense for
      // it, and validateSchedule is what drops the ones the new kind can't use.
      const merged = { ...existing[0], ...body };
      const checked = validateSchedule(merged);
      if (checked.error) return res.status(400).json({ error: checked.error });

      const schedule = checked.schedule;
      const enabled = body.enabled === undefined ? existing[0].enabled : !!body.enabled;
      const { rows } = await db().query(
        `update schedules
            set kind = $2, interval_hours = $3, hour = $4, minute = $5, weekday = $6,
                tz = $7, enabled = $8, next_run_at = $9, updated_at = now()
          where id = $1 returning ${COLS}`,
        [
          req.params.id,
          schedule.kind,
          schedule.interval_hours,
          schedule.hour,
          schedule.minute,
          schedule.weekday,
          schedule.tz,
          enabled,
          nextSlot(schedule),
        ]
      );
      res.json(rows[0]);
    })
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rowCount } = await db().query('delete from schedules where id = $1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    })
  );

  return r;
}
