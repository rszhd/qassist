// @ts-check
// The fake dataset a fresh tenant is seeded with: the demo sandbox's per-visitor
// tenant (US-036) and the staging box's long-lived one (US-038,
// `scripts/seed-staging.mjs`).
//
// Split out of `demoTenant.js`, which now owns only provisioning and the cap.
// The dataset is the part that grows — every shipped story that stores anything
// adds rows here so a visitor meets the feature instead of an empty panel — and
// it had already pushed that file past the size line CLAUDE.md draws.
//
// Seed is rows, not files: it copies no artifacts. Recordings and PDFs stay
// shared read-only fixtures under `demo/`, referenced by the replay interceptor,
// so the seeded history rows carry `report_status 'none'` and no recording and
// therefore offer no link to 404 on. The live replay is where an artifact comes
// from.
//
// The dataset lives here as a JS structure rather than a templated seed.sql: the
// rows cross-reference through generated UUIDs, which a single parameterized
// statement can't thread cleanly and pg-mem (where the provision+seed test runs)
// won't execute as a modifying CTE. Sequential parameterized inserts are simple
// and testable on both.
import crypto from 'node:crypto';
import { encryptSecret } from './crypto.js';
import { MEMORY_FORMAT_VERSION } from './testMemory.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Two seed tests mirror the checked-in replay fixtures exactly (goal + start_url
// match demo/<slug>/meta.json) so the run interceptor can pick the right clip;
// the rest fall back to a default. Keep these in sync with the fixtures — and
// keep them free of `{{variables}}`, because what the interceptor matches on is
// the *resolved* goal and URL.
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

// The test that PRODUCES the saved session (US-043), which is why it uses none
// itself. Its password is the one credential a demo tenant holds: declared
// secret, so the value lives encrypted in `test_secrets` (US-064) and the
// editor shows it set without ever reading it back.
const TEST_LOGIN = {
  name: 'Sign in to the storefront',
  goal:
    'Sign in with the email {{shopper_email}} and the password {{shopper_password}}, ' +
    'then confirm the account menu shows the signed-in shopper.',
  start_url: 'https://shop.example/account/login',
  variables: [
    { name: 'shopper_email', value: 'demo.shopper@example.com', secret: false, optional: false },
    // A secret declaration never carries its own value — `secretWrites` does.
    { name: 'shopper_password', value: '', secret: true, optional: false },
  ],
};
const LOGIN_PASSWORD = 'demo-shopper-not-a-real-password';

// The variable test (US-035), and the one that shows a variable reaching the URL
// rather than only the goal: `env` resolves inside the host, and the resolved
// host is what the project's allowlist below is written to admit.
const TEST_HOMEPAGE = {
  name: 'Homepage loads without errors',
  goal: 'Open the {{env}} storefront homepage and confirm it renders with no console errors.',
  start_url: 'https://{{env}}.shop.example/',
  variables: [{ name: 'env', value: 'staging', secret: false, optional: false }],
};

// No project, so it exercises the "Ungrouped" bucket — and, having no project,
// no allowlist, no preamble and no fixtures either, which is the shape every
// test on a fresh install has.
const TEST_SEARCH = {
  name: 'Product search returns results',
  goal: "Search for 'shoes' and confirm at least one product is listed.",
  start_url: 'https://shop.example/',
};

// A plausible Playwright storageState: what the extension (US-063) reads out of
// a browser the user is already signed in to. Stored encrypted, like every
// credential this app holds, and never returned by a read endpoint — the counts
// beside it are what the UI describes a session with.
const STORAGE_STATE = {
  cookies: [
    { name: 'session', value: 'demo-storefront-session', domain: 'shop.example', path: '/' },
    { name: 'cart', value: 'a41f', domain: 'shop.example', path: '/' },
  ],
  origins: [
    {
      origin: 'https://shop.example',
      localStorage: [{ name: 'shopper', value: '{"name":"Demo Shopper"}' }],
    },
  ],
};

// The two notebooks, as `[section, cited steps, the lesson, extras]`. The agent
// writes an `avoid_next_time` item as three sentences — what was tried, why it
// was wrong, and what to do instead — and the panel renders all three, so a
// seeded one carries all three too.
const LESSONS_REGISTER = [
  [
    'successful_approach',
    [1],
    { text: 'Sign Up is in the top-right header, not in the page body — open it from there.' },
  ],
  [
    'orientation',
    [5],
    {
      text:
        'Registration ends at the "activation email sent" screen; there is no ' +
        'confirmation page after it.',
    },
    // The one lesson a person contributed (US-079), so the panel's "From a run
    // you guided" credit is visible rather than theoretical.
    { hinted: true },
  ],
  [
    'avoid_next_time',
    [3],
    {
      attempt: 'Submitting the form before filling the username',
      reason: 'the page re-rendered with a validation error and kept none of the fields',
      instead: 'fill email, username and password, then press Sign Up once',
    },
  ],
];
const LESSONS_DISCOUNT = [
  [
    'orientation',
    [2],
    {
      text:
        'The promo field is on the checkout page under "Order summary", collapsed ' +
        'behind "Add a code".',
    },
  ],
  [
    'avoid_next_time',
    [3],
    {
      attempt: 'Reading the discounted total off the cart page',
      reason: 'the cart shows the pre-discount total and never updates',
      instead: 'read the order total on the checkout page after the code is applied',
    },
  ],
];

/**
 * A lesson's identity, by the same rule `agent/run_memory.py:item_id` uses —
 * its section and its own words, so a later real run that reaches the same
 * lesson recognises this one instead of appending a copy. It matters on
 * staging, where runs are real; in the sandbox nothing ever merges against it.
 * @param {string} section
 * @param {string[]} texts
 */
function lessonId(section, texts) {
  const payload = [section, ...texts].join('\x00');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
}

/**
 * One notebook item with its id and provenance filled in (US-081). Provenance is
 * per item because a notebook accumulates across runs, and `run_id` has to name
 * a run this tenant actually has — the panel links to it.
 * @param {string} section
 * @param {{ text?: string, attempt?: string, reason?: string, instead?: string }} lesson
 * @param {{ steps: number[], runId: string, at: Date, hinted?: boolean }} from
 */
function lesson(section, { text, attempt, reason, instead }, { steps, runId, at, hinted = false }) {
  const texts = section === 'avoid_next_time' ? [attempt, reason, instead] : [text];
  return {
    id: lessonId(section, /** @type {string[]} */ (texts)),
    ...(text ? { text } : { attempt, reason, instead }),
    steps,
    run_id: runId,
    learned_at: at.toISOString(),
    hinted,
  };
}

/**
 * A lesson table as the `learned` column holds it: the agent's sections, each an
 * array. One run and one timestamp for the whole notebook here, where a real one
 * accumulates across several — the provenance is still per item, because that is
 * the shape the panel and the eviction backstop read.
 * @param {any[][]} lessons
 * @param {{ runId: string, at: Date }} from
 */
function notebook(lessons, { runId, at }) {
  /** @type {Record<string, any[]>} */
  const learned = {};
  for (const [section, steps, fields, extra = {}] of lessons) {
    learned[section] = learned[section] || [];
    learned[section].push(lesson(section, fields, { steps, runId, at, ...extra }));
  }
  return learned;
}

/**
 * What a run of `steps` steps spent (US-046). Shaped like a real one rather than
 * round numbers: the prompt grows with the page context every step carries and
 * the completion barely moves.
 * @param {number} steps
 */
function usageFor(steps) {
  const prompt = 3800 * steps + 1200;
  const completion = 240 * steps + 90;
  // A plausible small-model price, per million tokens. The number only has to be
  // the right shape — nothing bills off it, and `cost_known` is what says
  // whether it may be believed at all.
  const cost = Math.round((prompt * 0.15 + completion * 0.6) / 1e6 * 1e6) / 1e6;
  return { prompt, completion, total: prompt + completion, cost };
}

// The hour a seeded daily schedule fires at, in UTC — the seed sets no `tz`, so
// the slot math resolves there and this constant is the whole of it.
const SCHEDULE_HOUR = 9;

/**
 * The next slot a daily schedule at `SCHEDULE_HOUR` fires into, strictly after
 * `now`. Every other timestamp in the schedule's story is measured back from
 * this one, which is what keeps `firesIntoNothing` quiet: that check reads the
 * slot BEFORE `next_run_at` and asks whether `last_run_at` reached it. Anchoring
 * `next_run_at` to "now plus a day" instead lands between slots, and a tenant
 * one second old is then tagged as having missed a firing.
 * @param {number} now
 */
function nextSlot(now) {
  const at = new Date(now);
  at.setUTCHours(SCHEDULE_HOUR, 0, 0, 0);
  if (at.getTime() <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/**
 * Seed a freshly-minted tenant with the fixed fake dataset, all owned by
 * userId. Runs on the caller's transaction client so provisioning is atomic.
 *
 * Exported because staging seeds the same dataset (US-038) — a populated
 * non-production database is what a migration gets rehearsed against, and it
 * wants exactly this shape. That caller supplies its own long-lived user rather
 * than a TTL'd demo one.
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {number} now epoch ms — anchors run/schedule timestamps
 */
export async function seedTenant(client, userId, now) {
  const one = async (/** @type {string} */ sql, /** @type {any[]} */ params) =>
    (await client.query(sql, params)).rows[0];

  /**
   * @param {{ name: string, slug: string, allowed: string[], preamble?: any[] }} p
   */
  const insertProject = (p) =>
    one(
      `insert into projects (user_id, name, slug, allowed_domains, initial_actions)
       values ($1, $2, $3, $4, $5) returning id`,
      [userId, p.name, p.slug, p.allowed, JSON.stringify(p.preamble || [])]
    );

  // Two projects, because one cannot show what a project is FOR: the fence
  // (US-042) and the preamble (US-043) are per-project, and both read as
  // arbitrary until there is a second project whose settings differ. They also
  // put each test under the domain it actually visits — the register fixture
  // runs against a Discourse forum, which no allowlist for a storefront could
  // honestly admit.
  const storefront = await insertProject({
    name: 'Acme Storefront',
    slug: 'acme-storefront',
    allowed: ['shop.example', '*.shop.example'],
    // Two wasted steps on every run in this project, every night, forever —
    // which is the case for a preamble even on a project with no session.
    preamble: [{ send_keys: { keys: 'Escape' } }, { wait: { seconds: 1 } }],
  });
  const forum = await insertProject({
    name: 'Discourse Forum',
    slug: 'discourse-forum',
    allowed: ['try.discourse.org'],
  });
  const module = await one(
    'insert into modules (project_id, name, slug) values ($1, $2, $3) returning id',
    [storefront.id, 'Checkout', 'checkout']
  );

  /**
   * @param {{ name: string, goal: string, start_url: string, variables?: any[] }} t
   * @param {{ projectId?: string|null, moduleId?: string|null }} [group]
   */
  const insertTest = async (t, { projectId = null, moduleId = null } = {}) => {
    const row = await one(
      `insert into tests (user_id, name, goal, start_url, project_id, module_id, variables)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        userId,
        t.name,
        t.goal,
        t.start_url,
        projectId,
        moduleId,
        JSON.stringify(t.variables || []),
      ]
    );
    return { id: row.id, goal: t.goal, start_url: t.start_url };
  };

  const login = await insertTest(TEST_LOGIN, { projectId: storefront.id });
  const discount = await insertTest(FIXTURE_DISCOUNT, {
    projectId: storefront.id,
    moduleId: module.id,
  });
  const homepage = await insertTest(TEST_HOMEPAGE, { projectId: storefront.id });
  const register = await insertTest(FIXTURE_REGISTER, { projectId: forum.id });
  await insertTest(TEST_SEARCH);

  await client.query(
    'insert into test_secrets (test_id, name, value_ciphertext) values ($1, $2, $3)',
    [login.id, 'shopper_password', encryptSecret(LOGIN_PASSWORD)]
  );

  // Captured, not empty. An uncaptured session is a real state (migration 016)
  // but it refuses every test that opts into it, so seeding one would hand a
  // visitor a checkout test that will not start.
  const session = await one(
    `insert into browser_sessions
       (project_id, name, name_key, storage_state_ciphertext, cookie_count, origin_count,
        captured_at, source, login_test_id, verify_url_contains, verify_text)
     values ($1, $2, $3, $4, $5, $6, $7, 'extension', $8, $9, $10) returning id`,
    [
      storefront.id,
      'Signed-in shopper',
      'signed-in shopper',
      encryptSecret(JSON.stringify(STORAGE_STATE)),
      STORAGE_STATE.cookies.length,
      STORAGE_STATE.origins.length,
      new Date(now - 3 * HOUR_MS),
      login.id,
      '/account',
      'Sign out',
    ]
  );
  // Set after the session exists, because the two rows point at each other: the
  // session names the test that fills it, and this test starts from what it holds.
  await client.query('update tests set browser_session_id = $2 where id = $1', [
    discount.id,
    session.id,
  ]);

  // No `fixtures` row (US-048), deliberately, and this is the one feature the
  // seed leaves empty. The table is metadata and the bytes live under
  // FIXTURES_DIR, but the panel's quota line is measured off DISK — so a row
  // with no file behind it lists a 4.7 KB fixture above the words "0 B used",
  // which is a contradiction on the one deployment whose job is to be believed.
  // Writing the bytes instead would leak a directory per visitor: the reaper
  // sweeps runs/<id>/ and nothing sweeps FIXTURES_DIR.

  const suite = await one(
    'insert into suites (user_id, project_id, name) values ($1, $2, $3) returning id',
    [userId, storefront.id, 'Smoke suite']
  );
  for (const [pos, testId] of [discount.id, homepage.id].entries()) {
    await client.query(
      'insert into suite_tests (suite_id, test_id, position) values ($1, $2, $3)',
      [suite.id, testId, pos]
    );
  }

  // Enabled, and its next slot is up to a day out: a tenant expires long before
  // it fires, so the scheduler never actually triggers a seeded schedule — it is
  // here to populate the Schedules view, not to run. `last_run_at` is the slot
  // before that one, because the runs below say it fired then.
  const upcoming = nextSlot(now);
  const schedule = await one(
    `insert into schedules (user_id, suite_id, kind, hour, enabled, next_run_at, last_run_at)
     values ($1, $2, 'daily', $3, true, $4, $5) returning id`,
    [userId, suite.id, SCHEDULE_HOUR, upcoming, new Date(upcoming.getTime() - DAY_MS)]
  );

  /**
   * One finished run. Terminal, and with no artifacts on disk to link to —
   * `report_status` and `has_recording` say so, so nothing in the UI offers a
   * PDF or a recording that is not there.
   *
   * `goal` and `start_url` default to the test's but are overridable, because a
   * run stores what it actually ran: a test declaring `{{env}}` keeps the
   * placeholder and its runs keep the value it resolved to (US-035). Copying the
   * declaration onto the row would show a URL nothing ever fetched.
   * @param {{ test: { id: string, goal: string, start_url: string }, ok: boolean,
   *           created: Date, steps: number, trigger?: string, result: string,
   *           goal?: string, start_url?: string,
   *           variables?: Record<string, string>, memoryUsed?: boolean,
   *           priced?: boolean, slot?: Date | null }} r
   */
  const insertRun = async (r) => {
    const id = crypto.randomUUID();
    const finished = new Date(r.created.getTime() + 90 * 1000);
    const usage = usageFor(r.steps);
    // US-046's whole point: an unknown cost carries no number. The row's own
    // check constraint refuses the pair any other way.
    const priced = r.priced ?? true;
    await client.query(
      `insert into runs
         (id, user_id, test_id, trigger, goal, start_url, max_steps, variables,
          status, success, final_result, steps_count,
          created_at, started_at, finished_at,
          schedule_id, scheduled_for, memory_used,
          prompt_tokens, completion_tokens, total_tokens, total_cost, cost_known)
       values ($1, $2, $3, $4, $5, $6, 60, $7,
          $8, $9, $10, $11, $12, $12, $13,
          $14, $15, $16,
          $17, $18, $19, $20, $21)`,
      [
        id,
        userId,
        r.test.id,
        r.trigger || 'ui',
        r.goal ?? r.test.goal,
        r.start_url ?? r.test.start_url,
        JSON.stringify(r.variables || {}),
        r.ok ? 'passed' : 'failed',
        r.ok,
        r.result,
        r.steps,
        r.created,
        finished,
        r.slot ? schedule.id : null,
        r.slot || null,
        !!r.memoryUsed,
        usage.prompt,
        usage.completion,
        usage.total,
        priced ? usage.cost : null,
        priced,
      ]
    );
    return id;
  };

  const PASSED_REGISTER = 'Goal met — the site confirmed an activation email was sent.';
  const FAILED_DISCOUNT =
    'The discount was accepted but never deducted from the total.';
  const PASSED_HOMEPAGE = 'Goal met — the homepage rendered with no console errors.';
  // What `{{env}}` stood for on every seeded run of the homepage test: the
  // resolved texts the run actually used, and the map that says what they came
  // from (US-035). The declaration itself stays on the test.
  const RESOLVED_HOMEPAGE = {
    goal: TEST_HOMEPAGE.goal.replace('{{env}}', 'staging'),
    start_url: TEST_HOMEPAGE.start_url.replace('{{env}}', 'staging'),
    variables: { env: 'staging' },
  };

  // The runs a person started. These two are the ones the notebooks below are
  // credited to, so their ids and their times are kept — the panel links to "the
  // run that found it", and a link to a run this tenant does not have is a 404.
  const registerAt = new Date(now - 2 * HOUR_MS);
  const discountAt = new Date(now - 5 * HOUR_MS);
  const registerRun = await insertRun({
    test: register,
    ok: true,
    created: registerAt,
    steps: 5,
    result: PASSED_REGISTER,
    memoryUsed: true,
  });
  const discountRun = await insertRun({
    test: discount,
    ok: false,
    created: discountAt,
    steps: 9,
    result: FAILED_DISCOUNT,
    memoryUsed: true,
  });
  await insertRun({
    test: homepage,
    ok: true,
    created: new Date(now - 26 * HOUR_MS),
    steps: 4,
    result: PASSED_HOMEPAGE,
    ...RESOLVED_HOMEPAGE,
  });
  // A CI trigger (US-008), and the one run nobody could price: a model with no
  // published price reports a cost of 0.0 exactly as a free one does, so the
  // estimate is withheld and the tokens still stand.
  await insertRun({
    test: register,
    ok: true,
    created: new Date(now - 50 * HOUR_MS),
    steps: 6,
    trigger: 'ci',
    result: PASSED_REGISTER,
    priced: false,
  });

  // Three firings of the suite schedule, two runs each, so the health strip
  // (US-069) has slots to draw and a story to tell: the checkout discount broke
  // two days ago and the nightly run has caught it since.
  for (const daysAgo of [1, 2, 3]) {
    const slot = new Date(upcoming.getTime() - daysAgo * DAY_MS);
    const created = new Date(slot.getTime() + 30 * 1000);
    const discountBroken = daysAgo < 3;
    await insertRun({
      test: discount,
      ok: !discountBroken,
      created,
      steps: discountBroken ? 9 : 7,
      trigger: 'schedule',
      slot,
      result: discountBroken ? FAILED_DISCOUNT : 'Goal met — the 20% discount came off the total.',
      memoryUsed: true,
    });
    await insertRun({
      test: homepage,
      ok: true,
      created,
      steps: 4,
      trigger: 'schedule',
      slot,
      result: PASSED_HOMEPAGE,
      ...RESOLVED_HOMEPAGE,
    });
  }

  // What those runs left in their tests' notebooks (US-081). Seeded rather than
  // left empty because the feature is invisible until a test has learned
  // something: with no row the panel is not rendered at all, which is correct
  // for a new test and useless for a demo.
  const notebooks = [
    { testId: register.id, lessons: LESSONS_REGISTER, runId: registerRun, at: registerAt },
    { testId: discount.id, lessons: LESSONS_DISCOUNT, runId: discountRun, at: discountAt },
  ];
  for (const { testId, lessons, runId, at } of notebooks) {
    await client.query(
      `insert into test_memory (test_id, format_version, learned, learned_at)
       values ($1, $2, $3, $4)`,
      [testId, MEMORY_FORMAT_VERSION, JSON.stringify(notebook(lessons, { runId, at })), at]
    );
  }
}
