// @ts-check
// Project fixtures over HTTP (US-048). These are handlers rather than a router:
// they mount on `routes/projects.js`'s own router so the `r.param('project')`
// resolver — which is what scopes every one of them to the calling tenant —
// cannot be bypassed by a mounting mistake. They live here because projects.js
// is already at the file-size line CLAUDE.md draws.
//
// The bytes arrive as a raw body with the name in the query string, rather than
// as multipart. One dependency fewer, `fetch(url, { body: file })` on the
// frontend and `curl --data-binary` in CI — but mainly one input carrying a
// filename instead of two, on a story whose acceptance criterion is that a path
// traversal fails. The query string also keeps the name clear of path splitting
// and percent-decoding entirely.
import express from 'express';
import fs from 'node:fs';
import { db } from '../db.js';
import { FIXTURE_MAX_BYTES, FIXTURE_PROJECT_QUOTA_BYTES } from '../config.js';
import {
  fixtureDir,
  fixtureKey,
  fixturePath,
  projectUsageBytes,
  withinQuota,
} from '../fixtures.js';
import { isUniqueViolation } from './helpers.js';

/** @typedef {import('./helpers.js').AppRequest} AppRequest */

const FIXTURE_COLS = 'id, filename, size_bytes, content_type, created_at';

const raw = express.raw({ type: () => true, limit: FIXTURE_MAX_BYTES });

/**
 * Buffer the upload body, and turn the body parser's own size refusal into the
 * same 413 the quota check produces. Without this the global error handler
 * reports a 500 for a file that is merely too big, which reads as "the server
 * is broken" rather than "that file is too large".
 * @type {import('express').RequestHandler}
 */
export function fixtureBody(req, res, next) {
  raw(req, res, (err) => {
    if (!err) return next();
    if (/** @type {any} */ (err).type === 'entity.too.large') {
      res.status(413).json({ error: overSizeMessage() });
      return;
    }
    next(err);
  });
}

function overSizeMessage() {
  const limit = Math.round((FIXTURE_MAX_BYTES / (1024 * 1024)) * 10) / 10;
  return `file is larger than the ${limit} MB limit for one fixture`;
}

/** GET /api/projects/:project/fixtures */
export async function listFixtures(req, res) {
  const project = /** @type {AppRequest} */ (req).project;
  const { rows } = await db().query(
    `select ${FIXTURE_COLS} from fixtures where project_id = $1 order by filename`,
    [project.id]
  );
  res.json({
    fixtures: rows,
    // Counted off disk, like the whitelist, so the number the user is held to
    // is the number the disk is holding.
    used_bytes: projectUsageBytes(project.id),
    quota_bytes: FIXTURE_PROJECT_QUOTA_BYTES,
    max_bytes: FIXTURE_MAX_BYTES,
  });
}

/** POST /api/projects/:project/fixtures?filename=cv.pdf */
export async function uploadFixture(req, res) {
  const project = /** @type {AppRequest} */ (req).project;
  const resolved = fixturePath(project.id, req.query.filename);
  if ('error' in resolved) return res.status(400).json({ error: resolved.error });
  const { path: target, filename } = resolved;

  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  if (!bytes) return res.status(400).json({ error: 'the request body must be the file itself' });

  const quota = withinQuota({
    storedBytes: projectUsageBytes(project.id),
    incomingBytes: bytes.length,
  });
  if ('error' in quota) return res.status(413).json({ error: quota.error });

  // The row goes in first, and the unique constraint is what detects a
  // duplicate — a select-then-insert would leave two concurrent uploads of the
  // same name racing to overwrite each other's bytes. Ordering matters the
  // other way too: bytes on disk with no row are a file the agent may attach,
  // the quota counts, and the UI cannot show anyone how to delete. A row with
  // no bytes is merely a listing that heals on the next upload.
  let row;
  try {
    ({ rows: [row] } = await db().query(
      `insert into fixtures (project_id, filename, name_key, size_bytes, content_type)
       values ($1, $2, $3, $4, $5) returning ${FIXTURE_COLS}`,
      [project.id, filename, fixtureKey(filename), bytes.length, req.get('content-type') || null]
    ));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        error: `this project already has a fixture called ${filename} — delete it first`,
      });
    }
    throw err;
  }

  try {
    fs.mkdirSync(fixtureDir(project.id), { recursive: true });
    fs.writeFileSync(target, bytes);
  } catch (err) {
    await db().query('delete from fixtures where id = $1', [row.id]);
    throw err;
  }

  res.status(201).json(row);
}

/** DELETE /api/projects/:project/fixtures/:filename */
export async function deleteFixture(req, res) {
  const project = /** @type {AppRequest} */ (req).project;
  const resolved = fixturePath(project.id, req.params.filename);
  if ('error' in resolved) return res.status(400).json({ error: resolved.error });

  const { rowCount } = await db().query(
    'delete from fixtures where project_id = $1 and name_key = $2',
    [project.id, fixtureKey(resolved.filename)]
  );
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  // After the row, so a crash in between leaves bytes with no listing rather
  // than a listing promising bytes that are gone — and the next upload of the
  // same name overwrites them.
  fs.rmSync(resolved.path, { force: true });
  res.status(204).end();
}

