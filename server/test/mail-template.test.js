// @ts-check
// The shared email layout (US-057). Pure: no DB, no network, no app — this
// file pins what the template guarantees, and the three send-site tests
// (notify.test.js, auth-mail.test.js, activation-gate.test.js) pin that each
// caller actually uses it.
//
// Two of these are load-bearing rather than cosmetic. Escaping, because a goal
// and the judge's own prose reach the template from outside and land in a
// recipient's inbox. And the no-network rule, because an email that fetches
// anything is an email whose brand is a grey box behind "display images below"
// — and a tracking pixel we never agreed to ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderEmail,
  button,
  esc,
  facts,
  note,
  panel,
  paragraph,
  pre,
  rawLink,
} from '../src/mailTemplate.js';

const HOSTILE = '<script>alert("x")</script> & "quoted" \'apostrophe\'';

test('caller text is escaped, in every block that takes it', () => {
  const blocks = [
    paragraph(HOSTILE),
    note(HOSTILE),
    panel(HOSTILE, 'bad'),
    pre(HOSTILE),
    facts([['Goal', HOSTILE]]),
    button(HOSTILE, `https://qa.example.com/?q=${HOSTILE}`),
    rawLink(`https://qa.example.com/?q=${HOSTILE}`),
  ];
  const { html } = renderEmail({ heading: HOSTILE, preheader: HOSTILE, blocks });

  assert.ok(!html.includes('<script'), 'a goal cannot open a tag');
  assert.ok(!html.includes('alert("x")'), 'nor smuggle one through an attribute quote');
  assert.ok(html.includes('&lt;script&gt;'), 'it renders as the text it is');
  // Every double quote left in the document is one of ours: an unescaped one
  // in caller text is how you break out of style="…" or href="…".
  assert.ok(!html.includes('"quoted"'), 'quotes cannot terminate an attribute');
  assert.ok(html.includes('&quot;quoted&quot;'));
});

test('esc leaves ordinary prose alone', () => {
  assert.equal(esc('Checkout — 3 steps, 12s'), 'Checkout — 3 steps, 12s');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

test('the message loads nothing from the network', () => {
  const { html } = renderEmail({
    heading: 'Anything',
    blocks: [paragraph('body'), button('Go', 'https://qa.example.com/runs/1')],
    unsubscribeUrl: 'https://qa.example.com/api/notifications/unsubscribe?x=1',
  });
  // Every source in the document is a cid: — a reference into this message's
  // own attachments, which is the one kind that fetches nothing.
  for (const [, src] of html.matchAll(/\bsrc\s*=\s*"([^"]*)"/gi)) {
    assert.match(src, /^cid:/, `${src} is fetched from somewhere`);
  }
  assert.ok(!/url\(/i.test(html), 'no CSS-fetched asset');
  // Links are the exception, and they are the point.
  assert.ok(html.includes('href="https://qa.example.com/runs/1"'));
});

test('the mark travels with the message the cid points at', () => {
  const { html, attachments } = renderEmail({ heading: 'Anything', blocks: [] });
  const cid = html.match(/src="cid:([^"]+)"/)?.[1];
  assert.ok(cid, 'the lockup references an image');

  const mark = attachments.find((a) => a.content_id === cid);
  assert.ok(mark, 'and the attachment it names is in the same object as the body');
  assert.ok(Buffer.from(mark.content, 'base64').length > 0, 'with bytes in it');
  // PNG, not the SVG the app and the favicon use: Gmail strips <svg> outright.
  assert.equal(mark.content_type, 'image/png');
  assert.equal(Buffer.from(mark.content, 'base64').subarray(1, 4).toString(), 'PNG');
});

test('the document declares itself dark, so no client inverts it', () => {
  const { html } = renderEmail({ heading: 'Anything', blocks: [paragraph('body')] });
  assert.match(html, /<meta name="color-scheme" content="dark"/);
  assert.match(html, /<meta name="supported-color-schemes" content="dark"/);
  assert.match(html, /color-scheme:dark/);
  assert.match(html, /<!doctype html>/i);
});

test('a multi-line verdict keeps its lines', () => {
  const html = panel('first line\nsecond line', 'bad');
  assert.match(html, /first line<br \/>second line/);
});

test('a fact with no value is dropped, not printed empty', () => {
  const html = facts([
    ['Goal', 'log in'],
    ['Duration', null],
    ['Steps', 0],
    ['URL', ''],
  ]);
  assert.match(html, /Goal/);
  assert.ok(!html.includes('Duration'), 'a null duration is a row that should not exist');
  assert.ok(!html.includes('URL'));
  assert.match(html, /Steps/, 'but zero is a value — it is a step count of none, not a missing one');
  assert.equal(facts([['Duration', null]]), '', 'all-empty renders nothing at all');
});

test('the unsubscribe link is in the HTML only when there is one', () => {
  const url = 'https://qa.example.com/api/notifications/unsubscribe?email=a%40b.c&t=abc';
  const { html: withLink } = renderEmail({ heading: 'Report', blocks: [], unsubscribeUrl: url });
  assert.ok(withLink.includes(`href="${esc(url)}"`));
  assert.match(withLink, />Unsubscribe</);

  const { html: without } = renderEmail({ heading: 'Report', blocks: [] });
  assert.ok(!without.includes('Unsubscribe'), 'a sign-in link has nothing to unsubscribe from');
});

test('the wordmark and the heading are always there', () => {
  const { html } = renderEmail({ heading: 'FAILED — checkout smoke', blocks: [] });
  assert.match(html, />QAssist</);
  assert.match(html, /FAILED — checkout smoke/);
});

test('a falsy block is skipped rather than rendering an empty row', () => {
  const { html } = renderEmail({ heading: 'x', blocks: [paragraph('kept'), '', null] });
  assert.equal(html.match(/<tr><td style="padding:0 0 18px;">/g)?.length, 1);
});
