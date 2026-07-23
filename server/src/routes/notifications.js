// @ts-check
// The one notification endpoint a recipient reaches (US-012): unsubscribe.
//
// It is the only route in the app that carries no bearer token, deliberately —
// the person clicking it is a colleague who was mailed a report, not an API
// caller, and asking them for the instance's API token to stop receiving mail
// would mean nobody ever stops receiving mail. The signature in the link is
// the credential, and it authorises exactly one thing: suppressing the address
// it was issued for.
import express from 'express';
import { db } from '../db.js';
import { suppress, verifyUnsubscribe } from '../notify.js';
import { h, requireDb } from './helpers.js';

/** A reply for a mail client's browser — no app shell, no token, one sentence. */
function page(title, body) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<body style="font: 15px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem">
<h1 style="font-size: 1.2rem">${title}</h1>
<p>${body}</p>
</body>`;
}

/** @param {{ checkToken: import('express').RequestHandler }} deps */
export function notificationsRouter({ checkToken }) {
  const r = express.Router();
  r.use(requireDb);

  r.get(
    '/unsubscribe',
    h(async (req, res) => {
      const email = String(req.query.email || '');
      const token = String(req.query.t || '');
      if (!email || !verifyUnsubscribe(email, token)) {
        return res
          .status(400)
          .type('html')
          .send(page('Link not valid', 'This unsubscribe link is expired or incomplete.'));
      }
      await suppress(email);
      res
        .type('html')
        .send(
          page(
            'Unsubscribed',
            `<strong>${email}</strong> will no longer receive test result email from this QAssist instance.`
          )
        );
    })
  );

  // Who has opted out, and undoing it. Token-guarded like the rest of the API.
  // Both exist because a suppression is otherwise invisible: mail to that
  // address just stops, and an accidental click would be undoable only in SQL.
  r.get(
    '/suppressions',
    checkToken,
    h(async (_req, res) => {
      const { rows } = await db().query(
        'select email, created_at from email_suppressions order by created_at desc'
      );
      res.json({ suppressions: rows });
    })
  );

  r.delete(
    '/suppressions/:email',
    checkToken,
    h(async (req, res) => {
      const { rowCount } = await db().query('delete from email_suppressions where email = $1', [
        String(req.params.email).toLowerCase(),
      ]);
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    })
  );

  return r;
}
