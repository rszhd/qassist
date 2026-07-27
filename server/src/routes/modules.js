// @ts-check
// Modules (US-023): a grouping inside a project — `auth`, `payment`,
// `checkout`. The rule that separates a module from a suite is that a test
// belongs to at most one module, so modules partition a project's tests.
//
// These are the id-addressed routes. Creating and listing modules happens
// under their project (routes/projects.js), as does the slug-addressed run
// path CI uses.
import express from 'express';
import { db } from '../db.js';
import { h, requireDb, requireAgentKey, requireEntitled, withUserCap } from './helpers.js';
import { isUuid } from '../db.js';
import { MODULE_COLS, findModuleById, listModules, resolveSlug, runModule } from './projects.js';

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function modulesRouter({ checkToken }) {
  const r = express.Router();
  r.use(checkToken, requireDb);

  // Flat list, mirroring /api/suites: a caller that wants to offer every
  // module at once (the schedule target picker) would otherwise have to walk
  // the projects and fetch each one's modules separately.
  r.get(
    '/',
    h(async (req, res) => {
      const { project_id } = req.query;
      const filtered = typeof project_id === 'string' && project_id;
      if (filtered && !isUuid(project_id)) {
        return res.status(400).json({ error: 'invalid project_id' });
      }
      res.json({ modules: await listModules(filtered ? project_id : null) });
    })
  );

  r.put(
    '/:id',
    h(async (req, res) => {
      const mod = await findModuleById(req.params.id);
      if (!mod) return res.status(404).json({ error: 'not found' });
      const body = req.body || {};
      const slug = await resolveSlug(body, mod, 'modules', 'project_id', mod.project_id);
      if (slug.error) return res.status(400).json({ error: slug.error });
      const { rows } = await db().query(
        `update modules set name = coalesce($2, name), slug = coalesce($3, slug),
                updated_at = now()
          where id = $1 returning ${MODULE_COLS}`,
        [mod.id, body.name ?? null, slug.slug]
      );
      res.json(rows[0]);
    })
  );

  // Member tests keep their project and fall back to ungrouped-within-project
  // (the FK is `on delete set null`) — deleting a group never deletes tests.
  r.delete(
    '/:id',
    h(async (req, res) => {
      const mod = await findModuleById(req.params.id);
      if (!mod) return res.status(404).json({ error: 'not found' });
      await db().query('delete from modules where id = $1', [mod.id]);
      res.status(204).end();
    })
  );

  r.post(
    '/:id/run',
    requireEntitled,
    requireAgentKey,
    withUserCap,
    h(async (req, res) => {
      const mod = await findModuleById(req.params.id);
      if (!mod) return res.status(404).json({ error: 'not found' });
      const result = await runModule(mod, req.body || {}, /** @type {any} */ (req).runOpenaiKey);
      if (result.empty) return res.status(400).json({ error: 'module has no tests' });
      res.json(result);
    })
  );

  return r;
}
