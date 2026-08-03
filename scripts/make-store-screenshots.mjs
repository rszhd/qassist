#!/usr/bin/env node
// Renders the five Chrome Web Store screenshots from the real popup (US-066).
//
// The listing needs 1280×800 shots of a 320px popup, and a popup that has to
// be driven by hand for each one is a listing asset that never gets redone
// when the UI changes. So this drives `extension/popup.js` itself — same
// markup, same stylesheet, same state machine — with `chrome.*` stubbed and
// the flow seeded to land on each screen.
//
// What is faked and why: the account screen would otherwise carry the
// maintainer's own Chrome profile email into a public listing, and the setup
// screen would carry a real capture token. Both are placeholders here, as is
// the site being captured. Nothing else is: what you see rendered is what the
// shipped code renders.
//
//   node scripts/make-store-screenshots.mjs   → dist/store-screenshots/*.png
//
// Serves over http rather than file:// because ES modules are blocked on
// file:// origins, and popup.js imports lib/.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = resolve(repoRoot, 'extension');
const outDir = resolve(repoRoot, 'dist/store-screenshots');

// Placeholders. A real profile email or a real capture token must never reach
// a public store listing.
const EMAIL = 'qa-bot@example.com';
const SITE = 'https://app.example.com';
const INSTANCE = 'https://app.qassist.run';
const SETUP_CODE = btoa(JSON.stringify({ token: 'demo-setup-token-not-a-real-one', instance_url: INSTANCE }));

/** Each shot: the caption under it, and the flow state it should open at. */
const SHOTS = [
  {
    name: '1-setup',
    caption: 'Paste the one-time code from QAssist',
    pending: null,
    fill: `document.getElementById('code').value = ${JSON.stringify(SETUP_CODE)};`,
  },
  {
    name: '2-site',
    caption: 'Name the one site to capture — never everything you browse',
    pending: { screen: 'origin', origin: SITE },
  },
  {
    name: '3-explain',
    caption: 'See what will be read, and where it goes, before the browser asks',
    pending: { screen: 'explain', origin: SITE },
    granted: false,
  },
  {
    name: '4-account',
    caption: 'Confirm which account is about to be captured, every time',
    pending: { screen: 'account', origin: SITE },
  },
  {
    name: '5-done',
    caption: 'Sent once, to your own QAssist instance',
    pending: { screen: 'account', origin: SITE },
    fill: `document.getElementById('confirm').click();`,
  },
];

/**
 * The popup's own stylesheet, rescoped from `body` to `.popup` so the shot
 * page can put a caption and a background around it. Read from popup.html
 * rather than copied, so a style change lands in the screenshots too.
 */
function popupStyles() {
  const html = readFileSync(resolve(extDir, 'popup.html'), 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (!style) throw new Error('popup.html has no <style> block to reuse');
  return style[1].replace(/\bbody\s*\{/g, '.popup {');
}

function shotPage(shot) {
  const pending = shot.pending ? { token: 'demo', instanceUrl: INSTANCE, origin: '', ...shot.pending, savedAt: Date.now() } : null;
  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
${popupStyles()}
  html, body { margin: 0; padding: 0; width: 1280px; height: 800px; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 44px;
         background: #17130f; color: #f1ede7;
         font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .caption { font-size: 27px; font-weight: 600; letter-spacing: -0.01em; max-width: 900px; text-align: center; }
  .popup { border-radius: 10px; box-shadow: 0 24px 60px rgba(0,0,0,.55); overflow: hidden; }
</style></head>
<body>
  <p class="caption">${shot.caption}</p>
  <div class="popup"><div id="app"></div></div>
  <script>
    // Enough of the extension APIs to render, and no more: nothing here
    // reads a cookie, opens a tab, or reaches the network.
    const local = { instanceUrl: ${JSON.stringify(INSTANCE)}, isTestProfile: true };
    const session = { pendingCapture: ${JSON.stringify(pending)} };
    const pick = (keys, store) => {
      const wanted = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(wanted.filter((k) => store[k] != null).map((k) => [k, store[k]]));
    };
    window.chrome = {
      storage: {
        local: { get: async (k) => pick(k, local), set: async () => {} },
        session: { get: async (k) => pick(k, session), set: async () => {}, remove: async () => {} },
      },
      identity: { getProfileUserInfo: async () => ({ email: ${JSON.stringify(EMAIL)} }) },
      permissions: { contains: async () => ${shot.granted === false ? 'false' : 'true'}, request: async () => true },
      tabs: { query: async () => [{ id: 1, url: ${JSON.stringify(SITE)} + '/dashboard' }] },
      cookies: { getAll: async () => [{ name: 'session', value: 'x', domain: 'app.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }] },
      scripting: { executeScript: async () => [{ result: [] }] },
    };
    window.fetch = async () => new Response(null, { status: 204 });
  </script>
  <script type="module" src="/popup.js"></script>
  <script type="module">
    // Module scripts run in order, so this one starts after popup.js's
    // top-level code. Everything left to settle is a microtask — the stubs
    // above resolve immediately, and nothing here touches a timer or the
    // network — so draining the microtask queue reaches the final screen,
    // before the first paint. Headless Chrome takes its shot without waiting
    // for the load event, so anything on a timer loses that race some of the
    // time; this cannot.
    const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

    await settle();
    ${shot.fill || ''}
    await settle();

    // Zoom to fill the frame, measured rather than guessed: the screens are
    // wildly different heights — the permission explainer is three times the
    // setup screen — and one fixed zoom either clips that one or leaves the
    // rest floating in a sea of background.
    const popup = document.querySelector('.popup');
    popup.style.zoom = String(Math.min(1.9, 640 / popup.getBoundingClientRect().height));
  </script>
</body></html>`;
}

const pages = new Map(SHOTS.map((s) => [`/${s.name}.html`, shotPage(s)]));

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (pages.has(path)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(pages.get(path));
  }
  try {
    const body = readFileSync(resolve(extDir, `.${path}`));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// Never execFileSync here: the server answering Chrome's requests runs in
// this same process, and a synchronous child blocks the event loop, so Chrome
// waits on a page that can never be served.
const run = promisify(execFile);

server.listen(0, '127.0.0.1', async () => {
  const { port } = /** @type {any} */ (server.address());
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const profile = resolve(outDir, '.chrome-profile');

  for (const shot of SHOTS) {
    const out = resolve(outDir, `${shot.name}.png`);
    await run('google-chrome', [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      // The only content rendered is the page generated above, from this
      // repo's own files — no untrusted input reaches this browser, and
      // Chrome's sandbox will not start in most container/CI environments.
      '--no-sandbox',
      // Its own profile, or a headless launch joins the Chrome the user
      // already has open and never returns.
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      `--screenshot=${out}`,
      `http://127.0.0.1:${port}/${shot.name}.html`,
    ], { stdio: 'ignore', timeout: 60_000 });
    console.log(out);
  }

  rmSync(profile, { recursive: true, force: true });
  writeFileSync(resolve(outDir, 'README.txt'), SHOTS.map((s, i) => `${i + 1}. ${s.name}.png — ${s.caption}`).join('\n') + '\n');
  server.close();
});
