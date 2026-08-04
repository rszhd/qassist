#!/usr/bin/env node
// A Resend-shaped sink, so an email can be looked at before anyone receives it
// (US-057). Same idea as rendering the report against sample-report.pdf: you
// iterate on the thing locally instead of mailing yourself.
//
//   node scripts/mail-preview.mjs            # listens, prints its URL
//   RESEND_API_URL=http://127.0.0.1:8025/emails npm run dev
//
// Every message the app sends is written to /tmp/qassist-mail/<n>-<slug>.html
// and its path printed. Open it in a browser for the layout; forward the file
// to a real Gmail and Apple Mail account for the render, which is the only
// place that question is actually answered.
//
// Deliberately not a fixture generator: it captures what the real composers
// produced, so a preview can never drift from what a recipient gets.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.PORT || 8025);
const OUT = process.env.MAIL_PREVIEW_DIR || path.join(os.tmpdir(), 'qassist-mail');
fs.mkdirSync(OUT, { recursive: true });

let n = 0;

// A browser resolves no `cid:` — that is a mail client's job — so the brand
// mark would be a broken image in every preview. Each inline attachment is
// written beside the html and its reference pointed at the file. Only the
// preview copy is rewritten; what went over the wire is untouched, and
// forwarding the file to a real inbox still tests the real cid path.
function inlined(msg, stem) {
  let html = msg.html;
  for (const a of msg.attachments || []) {
    if (!a.content_id) continue;
    const file = `${stem}-${a.filename}`;
    fs.writeFileSync(file, Buffer.from(a.content, 'base64'));
    html = html.replaceAll(`cid:${a.content_id}`, path.basename(file));
  }
  return html;
}

const slug = (s) =>
  String(s || 'message')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end('{}');
        return;
      }
      const stem = path.join(OUT, `${String(++n).padStart(3, '0')}-${slug(msg.subject)}`);
      const wrote = [];
      if (msg.html) {
        fs.writeFileSync(`${stem}.html`, inlined(msg, stem));
        wrote.push(`${stem}.html`);
      }
      if (msg.text) {
        fs.writeFileSync(`${stem}.txt`, msg.text);
        wrote.push(`${stem}.txt`);
      }
      console.log(
        `\n→ ${msg.subject}\n  to: ${(msg.to || []).join(', ')}` +
          (msg.attachments?.length ? `  (${msg.attachments.length} attachment(s))` : '') +
          (msg.html ? '' : '  [no html body]') +
          `\n  ${wrote.join('\n  ')}`
      );
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(`{"id":"preview_${n}"}`);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`mail preview sink → ${OUT}`);
    console.log(`point the app at it:  RESEND_API_URL=http://127.0.0.1:${PORT}/emails npm run dev`);
    console.log(`(MAIL_DEV_CONSOLE must be unset, or nothing reaches the wire)`);
  });
