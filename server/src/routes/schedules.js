// @ts-check
// Schedules (US-010): CRUD over the schedules table. One flat resource with
// the target in the body rather than four nested routers under tests, modules,
// suites and projects — those would be the same handler written four times.
//
// Every write recomputes next_run_at from the preset, so the scheduler's claim
// marker can never disagree with the schedule the user is looking at.
import express from 'express';
import { db, currentUserId, isUuid } from '../db.js';
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
//
// `target_tests` counts what the *scheduler* would find, which is why each
// branch mirrors the matching one in `scheduler.js`'s `testsOf` rather than
// counting the target's own rows — including the suite branch's join through
// `tests`, so the two can never disagree about whether a slot has work to do
// (BUG-006). A zero here is a schedule that fires into nothing.
//
// Grouped derived tables rather than the correlated subqueries this wants to
// be: pg-mem cannot see the outer alias from inside a subquery, and the route
// tests run on it. `count(*)` is bigint, which node-pg hands back as a string,
// hence the casts.
const LIST_QUERY = `
  select ${COLS.split(', ')
    .map((c) => `s.${c}`)
    .join(', ')},
         case when s.test_id is not null then 'test'
              when s.module_id is not null then 'module'
              when s.suite_id is not null then 'suite'
              else 'project' end as target_type,
         coalesce(t.name, m.name, u.name, p.name) as target_name,
         case when s.test_id is not null then (case when t.id is null then 0 else 1 end)
              when s.module_id is not null then coalesce(mc.n, 0)
              when s.suite_id is not null then coalesce(uc.n, 0)
              else coalesce(pc.n, 0) end as target_tests
    from schedules s
    left join tests t on t.id = s.test_id
    left join modules m on m.id = s.module_id
    left join suites u on u.id = s.suite_id
    left join projects p on p.id = s.project_id
    left join (select module_id, count(*)::int as n from tests
                where module_id is not null group by module_id) mc on mc.module_id = s.module_id
    left join (select project_id, count(*)::int as n from tests
                where project_id is not null group by project_id) pc on pc.project_id = s.project_id
    left join (select st.suite_id, count(*)::int as n from suite_tests st
                 join tests t2 on t2.id = st.test_id
                group by st.suite_id) uc on uc.suite_id = s.suite_id`;

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
  // Scope the target to the caller — a schedule can only point at something the
  // user owns. Modules carry no user_id of their own, so reach it through the
  // project (the same join the module routes use).
  const sql =
    table === 'modules'
      ? `select 1 from modules m join projects p on p.id = m.project_id
          where m.id = $1 and p.user_id = $2`
      : `select 1 from ${table} where id = $1 and user_id = $2`;
  const { rowCount } = await db().query(sql, [id, currentUserId()]);
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
      const params = [currentUserId()];
      const where = ['s.user_id = $1'];
      for (const [column] of TARGETS) {
        const value = req.query[column];
        if (typeof value !== 'string' || !value) continue;
        if (!isUuid(value)) return res.status(400).json({ error: `invalid ${column}` });
        params.push(value);
        where.push(`s.${column} = $${params.length}`);
      }
      const { rows } = await db().query(
        `${LIST_QUERY} where ${where.join(' and ')} order by s.next_run_at nulls last`,
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
          currentUserId(),
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
      const { rows: existing } = await db().query(
        `select ${COLS} from schedules where id = $1 and user_id = $2`,
        [req.params.id, currentUserId()]
      );
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
          where id = $1 and user_id = $10 returning ${COLS}`,
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
          currentUserId(),
        ]
      );
      res.json(rows[0]);
    })
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
      const { rowCount } = await db().query('delete from schedules where id = $1 and user_id = $2', [
        req.params.id,
        currentUserId(),
      ]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    })
  );

  return r;
}
