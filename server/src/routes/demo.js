// @ts-check
// Demo routes (US-033) — the one unauthenticated surface, so it is scoped like
// one: read-only, fixture-backed, no run/test creation, and rate-limited per IP
// so the recordings aren't a free bandwidth tap. Mounted only when DEMO_MODE is
// on (server.js); off means these paths 404 like any other unknown route.
import express from 'express';
import { listDemos, recordingPath, reportPath } from '../demo.js';
import { DEMO_SPEED, DEMO_CTA_URL } from '../config.js';
import { h } from './helpers.js';

// Fixed-window per-IP limiter. A video seek fires several Range requests, so the
// window is generous — it blocks a scraper hammering the recordings, not a
// visitor watching one. In-memory like the run relay; a restart resets it.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 120;
/** @type {Map<string, { count: number, resetAt: number }>} */
const hits = new Map();

/** @type {import('express').RequestHandler} */
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    hits.set(ip, entry);
  }
  entry.count++;
  if (entry.count > MAX_PER_WINDOW) {
    res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    res.status(429).json({ error: 'too many requests' });
    return;
  }
  next();
}

// Bounds the map so a stream of distinct source IPs can't grow it without
// limit. Cheap and unref'd; correctness doesn't depend on it (each entry also
// self-expires on next hit), it just reclaims idle keys.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (now >= entry.resetAt) hits.delete(ip);
}, WINDOW_MS).unref();

export function demoRouter() {
  const r = express.Router();
  r.use(rateLimit);

  // The picker's card list, plus how to end the replay: `ctaUrl` is null when
  // the app can offer its own login (multi mode) — the frontend links there
  // instead. `speed` drives the "condensed replay" note when it isn't 1.
  r.get('/', (_req, res) => {
    res.json({ demos: listDemos(), speed: DEMO_SPEED, ctaUrl: DEMO_CTA_URL });
  });

  // The stage visual. sendFile honours Range, so the <video> can seek without
  // downloading the whole clip — a plain <video src>, no auth, no blob fetch.
  r.get(
    '/:slug/recording',
    h(async (req, res) => {
      const file = recordingPath(req.params.slug);
      if (!file) return res.status(404).json({ error: 'no recording' });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `inline; filename="qassist-demo-${req.params.slug}.mp4"`);
      res.sendFile(file);
    })
  );

  // The same PDF a real run produces, served straight off the fixture — the
  // demo's verdict card offers it exactly as the run page does. Read-only, no
  // auth, opened inline in a new tab (no bearer header, unlike a real run's).
  r.get(
    '/:slug/report.pdf',
    h(async (req, res) => {
      const file = reportPath(req.params.slug);
      if (!file) return res.status(404).json({ error: 'no report' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="qassist-demo-${req.params.slug}.pdf"`);
      res.sendFile(file);
    })
  );

  return r;
}
