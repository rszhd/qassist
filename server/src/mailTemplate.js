// @ts-check
// The look of an outgoing message (US-057). `mail.js` is the transport and
// knows nothing about bodies; this file is the single layout every caller fills
// in, so the sign-in link, the run report and the activation mails read as one
// product rather than three inboxes' worth of ad-hoc HTML.
//
// **Dark, and only dark.** No client honours `prefers-color-scheme` reliably —
// Gmail ignores it and instead inverts light mail itself — so a light template
// is two designs we don't control. Clients leave an already-dark message alone,
// which makes dark the only palette that renders once. It is also the app's
// own: every colour below is a token copied from `frontend/src/App.css`'s
// `:root`, which is the dark theme (see `docs/design-system.md`).
//
// **Inline styles on tables**, because the Gmail app strips `<style>` for
// non-Gmail accounts and Outlook lays out with Word. **Nothing loads from the
// network**: the wordmark is text, so there is no blocked-image gap where the
// brand should be, and no pixel that reads as tracking.
//
// Every caller-supplied value goes through `esc()` — goals, URLs and the
// judge's own prose all arrive here from outside.

const PAGE = '#131316';
const CARD = '#1c1c20';
const SUNKEN = '#18181c';
const BORDER = '#2b2b31';
const TEXT = '#edeef0';
const MUTED = '#9b9ba3';
const FAINT = '#83838d';
const ACCENT = '#4d7cf6';
// White on the accent in either theme — a property of the accent, not of the
// theme (App.css says the same thing above its own palette).
const ON_ACCENT = '#ffffff';

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

/** Verdict tones: text weight, border weight, surface weight — App.css's trio. */
const TONES = {
  ok: { fg: '#4cb98a', line: '#2a5843', bg: '#17281f' },
  bad: { fg: '#e5787e', line: '#68373a', bg: '#2b1a1c' },
  warn: { fg: '#d9ad55', line: '#554423', bg: '#282116' },
  info: { fg: '#9db2d2', line: '#34404f', bg: '#1b2029' },
  neutral: { fg: MUTED, line: BORDER, bg: SUNKEN },
};

/** @typedef {keyof typeof TONES} Tone */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Escaped, with newlines kept — the judge's result text is written in lines. */
const escLines = (value) => esc(value).replace(/\r?\n/g, '<br />');

const BODY_TYPE = `font-family:${FONT};font-size:14px;line-height:1.65;`;

// --- blocks: what a caller composes a message out of -------------------------

/** A run of body text. @param {string} text */
export const paragraph = (text) => `<div style="${BODY_TYPE}color:${TEXT};">${escLines(text)}</div>`;

/** Secondary text — the caveat under a button, the sign-off. @param {string} text */
export const note = (text) =>
  `<div style="font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">${escLines(text)}</div>`;

/**
 * Label/value pairs, the report's spine. Empty values drop out rather than
 * printing a heading with nothing under it.
 * @param {[string, unknown][]} pairs
 */
export function facts(pairs) {
  const rows = pairs
    .filter(([, value]) => value != null && value !== '')
    .map(
      ([label, value]) =>
        `<tr>` +
        `<td style="font-family:${FONT};font-size:12px;letter-spacing:.06em;text-transform:uppercase;` +
        `color:${FAINT};padding:0 16px 8px 0;vertical-align:top;white-space:nowrap;">${esc(label)}</td>` +
        `<td style="${BODY_TYPE}color:${TEXT};padding:0 0 8px;vertical-align:top;word-break:break-word;">` +
        `${esc(value)}</td>` +
        `</tr>`
    )
    .join('');
  return rows
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`
    : '';
}

/**
 * A tinted panel — the verdict text, quoted rather than run in with our own.
 * @param {string} text @param {Tone} [tone]
 */
export function panel(text, tone = 'neutral') {
  const t = TONES[tone] || TONES.neutral;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    `<tr><td bgcolor="${t.bg}" style="border:1px solid ${t.line};border-radius:8px;padding:14px 16px;` +
    `${BODY_TYPE}color:${TEXT};">${escLines(text)}</td></tr></table>`
  );
}

/** Commands, meant to be copied. @param {string} text */
export const pre = (text) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
  `<tr><td bgcolor="${SUNKEN}" style="border:1px solid ${BORDER};border-radius:8px;padding:14px 16px;` +
  `font-family:${MONO};font-size:13px;line-height:1.7;color:${TEXT};white-space:nowrap;` +
  `overflow-x:auto;">${escLines(text)}</td></tr></table>`;

/** The one action. @param {string} label @param {string} href */
export const button = (label, href) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
  `<td bgcolor="${ACCENT}" style="border-radius:6px;">` +
  `<a href="${esc(href)}" style="display:inline-block;padding:11px 22px;font-family:${FONT};font-size:14px;` +
  `font-weight:500;line-height:1;color:${ON_ACCENT};text-decoration:none;border-radius:6px;">` +
  `${esc(label)}</a></td></tr></table>`;

/** The same URL in full, for the client that ate the button. @param {string} href */
export const rawLink = (href) =>
  `<div style="font-family:${MONO};font-size:12px;line-height:1.6;word-break:break-all;">` +
  `<a href="${esc(href)}" style="color:${ACCENT};text-decoration:none;">${esc(href)}</a></div>`;

// --- the layout every message is poured into ---------------------------------

/** @param {string[]} blocks */
const stack = (blocks) =>
  blocks
    .filter(Boolean)
    .map((block) => `<tr><td style="padding:0 0 18px;">${block}</td></tr>`)
    .join('');

/**
 * One message, as a complete HTML document.
 *
 * `preheader` is the line the inbox list shows next to the subject; left unset,
 * clients grab whatever text comes first, which is usually the wordmark.
 *
 * @param {{ heading: string,
 *           badge?: { label: string, tone: Tone } | null,
 *           preheader?: string,
 *           blocks?: string[],
 *           footer?: string[],
 *           unsubscribeUrl?: string | null }} content
 * @returns {string}
 */
export function renderEmail({
  heading,
  badge = null,
  preheader = '',
  blocks = [],
  footer = [],
  unsubscribeUrl = null,
}) {
  const tone = (badge && TONES[badge.tone]) || TONES.neutral;
  const badgeHtml = badge
    ? `<tr><td style="padding:0 0 10px;">` +
      `<span style="display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid ${tone.line};` +
      `background:${tone.bg};color:${tone.fg};font-family:${FONT};font-size:12px;font-weight:600;` +
      `letter-spacing:.06em;line-height:1;">${esc(badge.label)}</span></td></tr>`
    : '';

  const footerLines = [...footer];
  if (unsubscribeUrl) {
    footerLines.push(
      `<a href="${esc(unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>`
    );
  }
  const footerHtml = footerLines
    .map(
      (line) =>
        `<div style="font-family:${FONT};font-size:12px;line-height:1.7;color:${FAINT};">${line}</div>`
    )
    .join('');

  return `<!doctype html>
<html lang="en" style="color-scheme:dark;">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PAGE}" style="background-color:${PAGE};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;">
<tr><td style="padding:0 4px 18px;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:-.006em;color:${TEXT};">QAssist</td></tr>
<tr><td bgcolor="${CARD}" style="background-color:${CARD};border:1px solid ${BORDER};border-radius:10px;padding:28px 28px 10px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${badgeHtml}<tr><td style="padding:0 0 18px;font-family:${FONT};font-size:20px;font-weight:600;line-height:1.35;letter-spacing:-.006em;color:${TEXT};">${esc(heading)}</td></tr>
${stack(blocks)}</table>
</td></tr>
<tr><td style="padding:18px 4px 0;">${footerHtml}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
