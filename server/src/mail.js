// @ts-check
// The transport, and nothing else (US-012): one POST to Resend's REST API.
// No SDK — the call is a fetch with a JSON body, and a dependency that wraps
// that would be more code to audit than the code it replaces.
//
// Who gets mail and why lives in notify.js, what it looks like in
// mailTemplate.js; this file only knows how to hand an already-composed message
// to the provider.
import { RESEND_API_KEY, RESEND_API_URL, MAIL_FROM, MAIL_DEV_CONSOLE } from './config.js';

/** Sending needs both a key and a verified sender; either missing = feature off.
 *  The dev console transport (MAIL_DEV_CONSOLE) counts as configured on its own. */
export function mailEnabled() {
  return MAIL_DEV_CONSOLE || !!(RESEND_API_KEY && MAIL_FROM);
}

/**
 * Send one message. Throws on a non-2xx so the caller can record the reason
 * against the delivery row rather than losing it to a log line.
 *
 * `text` is required and `html` is not: text is the fallback a client renders
 * when it won't run the HTML, and it is the whole message on the dev console
 * transport. A caller that drops the text body to save the effort has made the
 * mail unreadable somewhere it used to be fine.
 * `content_id` on an attachment is what a `cid:` reference in the html body
 * resolves to — the template's brand mark travels that way. Without it the same
 * bytes arrive as a file to download.
 * @param {{ to: string, subject: string, text: string, html?: string,
 *           unsubscribeUrl?: string | null,
 *           attachments?: { filename: string, content: string,
 *                           content_type?: string, content_id?: string }[] }} msg
 * @returns {Promise<string>} the provider's message id
 */
export async function sendMail(msg) {
  if (MAIL_DEV_CONSOLE) {
    console.log(
      `\n[mail:dev] to=${msg.to}  subject=${msg.subject}\n${msg.text}\n` +
        (msg.attachments?.length ? `[${msg.attachments.length} attachment(s) omitted]\n` : '')
    );
    return 'dev-console';
  }
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments,
      // The header is what a mail client's own "unsubscribe" button reads;
      // without it the link in the body is the only way out.
      headers: msg.unsubscribeUrl ? { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>` } : undefined,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
  try {
    return JSON.parse(body).id || '';
  } catch {
    return '';
  }
}
