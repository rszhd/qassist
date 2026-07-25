// @ts-check
// Every HTTP path that can start a run. Enumerating them IS the risk — one
// forgotten path is the whole defect, which is how US-036's demo interceptor
// and US-022's billing gate were both specified. Shared between the US-039
// files (byok-only / byok-postgres) so the refusal half and the success half
// can never drift on to different lists.
//
// The story's "retry" and "CI/API" are not separate endpoints: they are these
// same routes with a different `trigger`, asserted separately.

/**
 * @typedef {{ projectSlug: string, moduleId: string, moduleSlug: string,
 *             testId: string, suiteId: string }} Fixtures
 * @type {[string, (f: Fixtures) => { url: string, body?: any }][]}
 */
export const RUN_PATHS = [
  [
    'ad-hoc POST /api/runs',
    () => ({ url: '/api/runs', body: { goal: 'log in', start_url: 'https://example.test' } }),
  ],
  ['POST /api/tests/:id/run', (f) => ({ url: `/api/tests/${f.testId}/run` })],
  ['POST /api/suites/:id/run', (f) => ({ url: `/api/suites/${f.suiteId}/run` })],
  ['POST /api/projects/:project/run', (f) => ({ url: `/api/projects/${f.projectSlug}/run` })],
  [
    'POST /api/projects/:project/modules/:module/run',
    (f) => ({ url: `/api/projects/${f.projectSlug}/modules/${f.moduleSlug}/run` }),
  ],
  ['POST /api/modules/:id/run', (f) => ({ url: `/api/modules/${f.moduleId}/run` })],
];

/**
 * One of everything runnable for `uid`, so every path above has a target.
 * @param {any} pool
 * @param {string} uid
 * @returns {Promise<Fixtures>}
 */
export async function seedRunTargets(pool, uid) {
  const short = uid.slice(0, 8);
  const project = (
    await pool.query(
      'insert into projects (user_id, name, slug) values ($1, $2, $3) returning id, slug',
      [uid, `proj ${short}`, `proj-${short}`]
    )
  ).rows[0];
  const mod = (
    await pool.query(
      'insert into modules (project_id, name, slug) values ($1, $2, $3) returning id, slug',
      [project.id, 'checkout', `checkout-${short}`]
    )
  ).rows[0];
  const t = (
    await pool.query(
      `insert into tests (user_id, name, goal, start_url, max_steps, project_id, module_id)
       values ($1, $2, $3, $4, 1, $5, $6) returning id`,
      [uid, 'login smoke', 'log in', 'https://example.test', project.id, mod.id]
    )
  ).rows[0];
  const suite = (
    await pool.query(
      'insert into suites (user_id, project_id, name) values ($1, $2, $3) returning id',
      [uid, project.id, 'smoke']
    )
  ).rows[0];
  await pool.query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, 0)', [
    suite.id,
    t.id,
  ]);
  return {
    projectSlug: project.slug,
    moduleId: mod.id,
    moduleSlug: mod.slug,
    testId: t.id,
    suiteId: suite.id,
  };
}
