// @ts-check
// The whole popup UI for QAssist Session Capture (US-063) — a small
// screen-by-screen state machine, no framework, no build step (this repo's
// stance: no codegen/build step where one isn't earned).
//
// The flow, in order, and why the order matters:
//   1. setup    — paste the one-time setup code minted in QAssist
//   2. origin   — name the one site to capture
//   3. explain  — say what will be read and where it goes, BEFORE the
//                 browser's permission prompt (the AC this screen exists for)
//   4. (chrome.permissions.request — the browser's own per-origin prompt)
//   5. account  — name the signed-in Chrome profile and require confirmation,
//                 gated on the isTestProfile flag from Settings
//   6. capturing/needTab — read cookies + localStorage from an already-open,
//                 already-signed-in tab; never opens a fresh one (a fresh tab
//                 would be signed out, defeating the whole mechanism)
//   7. success/error — on any failure, the assembled blob and the token are
//                 dropped from memory. Nothing here ever writes them to
//                 chrome.storage, IndexedDB, or retries automatically — that
//                 is a property of what this file does NOT do; verify by
//                 reading doCapture() below rather than by running anything.
import { buildStorageState } from './lib/storageState.js';
import { permissionPatterns, registrableDomain } from './lib/siteScope.js';

const APP = document.getElementById('app');

const state = {
  screen: 'setup',
  instanceUrl: '',
  token: '',
  origin: '',
  email: null,
  isTestProfile: false,
  errorMsg: '',
  previousScreen: null,
};

init();

async function init() {
  const stored = await chrome.storage.local.get(['instanceUrl', 'isTestProfile']);
  state.instanceUrl = stored.instanceUrl || '';
  state.isTestProfile = !!stored.isTestProfile;
  render();
}

function render() {
  switch (state.screen) {
    case 'origin':
      return renderOrigin();
    case 'explain':
      return renderExplain();
    case 'account':
      return renderAccount();
    case 'needTab':
      return renderNeedTab();
    case 'capturing':
      return renderCapturing();
    case 'success':
      return renderSuccess();
    case 'error':
      return renderError();
    case 'settings':
      return renderSettings();
    case 'setup':
    default:
      return renderSetup();
  }
}

/** Sets #app's markup and wires the settings link every screen carries. */
function setApp(html) {
  APP.innerHTML = html;
  const link = document.getElementById('settings-link');
  if (link) {
    link.addEventListener('click', () => {
      state.previousScreen = state.screen;
      state.screen = 'settings';
      render();
    });
  }
}

function header(title) {
  return `<h1><span>${escapeHtml(title)}</span><a class="link" id="settings-link">Settings</a></h1>`;
}

// --- Screens -----------------------------------------------------------

function renderSetup() {
  setApp(`
    ${header('QAssist')}
    <p class="muted">Paste the setup code from Sessions → "Capture with browser extension" in your QAssist instance.</p>
    ${errorBlock()}
    <textarea id="code" placeholder="Setup code"></textarea>
    <div class="row"><button class="primary" id="next">Continue</button></div>
  `);
  document.getElementById('next').addEventListener('click', () => {
    const raw = /** @type {HTMLTextAreaElement} */ (document.getElementById('code')).value;
    try {
      const { token, instanceUrl } = decodeSetupCode(raw);
      state.token = token;
      state.instanceUrl = instanceUrl;
      state.errorMsg = '';
      chrome.storage.local.set({ instanceUrl });
      state.screen = 'origin';
      render();
    } catch {
      state.errorMsg = 'That does not look like a setup code — copy it fresh from QAssist.';
      render();
    }
  });
}

function renderOrigin() {
  setApp(`
    ${header('Which site?')}
    <p class="muted">Type the site you are signed in to and want to capture.</p>
    ${errorBlock()}
    <input type="text" id="origin" placeholder="https://example.com" value="${escapeHtml(state.origin)}" />
    <div class="row">
      <button id="back">Back</button>
      <button class="primary" id="next">Continue</button>
    </div>
  `);
  document.getElementById('back').addEventListener('click', () => {
    state.screen = 'setup';
    render();
  });
  document.getElementById('next').addEventListener('click', () => {
    const raw = /** @type {HTMLInputElement} */ (document.getElementById('origin')).value.trim();
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      state.errorMsg = 'Enter a full URL, like https://example.com';
      render();
      return;
    }
    state.origin = parsed.origin;
    state.errorMsg = '';
    state.screen = 'explain';
    render();
  });
}

function renderExplain() {
  const root = registrableDomain(new URL(state.origin).hostname);
  setApp(`
    ${header('Before you continue')}
    <div class="box">
      <p>This will read <strong>cookies and local data</strong> for</p>
      <p class="mono">${escapeHtml(state.origin)}</p>
      <p>and send it to</p>
      <p class="mono">${escapeHtml(state.instanceUrl)}</p>
    </div>
    <p class="muted">Chrome will ask you to approve access to <strong>${escapeHtml(root)}</strong> and its subdomains next — not just this one page. Sites like Google split a login across several subdomains and share cookies between them, so a narrower grant would miss the session. QAssist never sees a password — only the cookies and local data this browser already holds.</p>
    <div class="row">
      <button id="back">Back</button>
      <button class="primary" id="grant">Continue</button>
    </div>
  `);
  document.getElementById('back').addEventListener('click', () => {
    state.screen = 'origin';
    render();
  });
  document.getElementById('grant').addEventListener('click', requestPermission);
}

async function requestPermission() {
  // Not just the exact host: a cookie scoped to the parent domain
  // (Domain=.google.com, how most SSO providers actually hold a session) is
  // invisible to chrome.cookies.getAll unless a granted host permission
  // covers it too — see lib/siteScope.js's header for how this was found.
  const patterns = permissionPatterns(state.origin);
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: patterns });
  } catch {
    granted = false;
  }
  if (!granted) {
    state.errorMsg = 'Permission was not granted — nothing was read.';
    state.screen = 'origin';
    render();
    return;
  }
  state.errorMsg = '';
  state.screen = 'account';
  render();
}

function renderAccount() {
  setApp(`${header('Checking this browser')}<p class="muted">Loading…</p>`);
  loadAccount();
}

async function loadAccount() {
  let info = null;
  try {
    info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
  } catch {
    info = null;
  }
  state.email = info && info.email ? info.email : null;
  renderAccountConfirm();
}

function renderAccountConfirm() {
  if (!state.isTestProfile) {
    setApp(`
      ${header('This is not a test profile')}
      <div class="box">
        <p>Signed-in Chrome profile:</p>
        <p class="email">${state.email ? escapeHtml(state.email) : '(none detected)'}</p>
      </div>
      <p class="muted">QAssist stores whatever this captures. Capturing from your daily browser hands it a personal account. Mark this profile as disposable/test-only in Settings before capturing from it.</p>
      <div class="row">
        <button id="back">Back</button>
        <button class="primary" id="goto-settings">Open settings</button>
      </div>
    `);
    document.getElementById('back').addEventListener('click', () => {
      state.screen = 'explain';
      render();
    });
    document.getElementById('goto-settings').addEventListener('click', () => {
      state.previousScreen = 'account';
      state.screen = 'settings';
      render();
    });
    return;
  }

  setApp(`
    ${header('Confirm the account')}
    <div class="box">
      <p>About to capture <strong>${escapeHtml(state.origin)}</strong> from:</p>
      <p class="email">${state.email ? escapeHtml(state.email) : '(no signed-in Chrome account detected)'}</p>
    </div>
    <p class="muted">Make sure this is the account you meant to capture, not a personal one.</p>
    ${errorBlock()}
    <div class="row">
      <button id="back">Back</button>
      <button class="primary" id="confirm">Yes, capture this session</button>
    </div>
  `);
  document.getElementById('back').addEventListener('click', () => {
    state.screen = 'explain';
    render();
  });
  document.getElementById('confirm').addEventListener('click', () => {
    state.errorMsg = '';
    state.screen = 'capturing';
    render();
    doCapture();
  });
}

function renderNeedTab() {
  setApp(`
    ${header('Open the site first')}
    <p class="muted">No open tab was found for <span class="mono">${escapeHtml(state.origin)}</span>. Local data can only be read from a tab that is already open and already signed in — open the site, sign in if needed, then try again.</p>
    <div class="row">
      <button id="back">Back</button>
      <button class="primary" id="retry">Try again</button>
    </div>
  `);
  document.getElementById('back').addEventListener('click', () => {
    state.screen = 'account';
    renderAccountConfirm();
  });
  document.getElementById('retry').addEventListener('click', () => {
    state.screen = 'capturing';
    render();
    doCapture();
  });
}

function renderCapturing() {
  setApp(`${header('Capturing…')}<p class="muted">Reading cookies and local data, then sending it to your instance.</p>`);
}

/**
 * The capture itself. `cookies`, `entries` and `storageState` are local to
 * this call — on any failure below, the function returns and they are gone.
 * Nothing here writes them to chrome.storage, caches them, or retries on its
 * own; a retry means the user pressing a button again, which re-reads fresh.
 */
async function doCapture() {
  try {
    const tabs = await chrome.tabs.query({ url: `${state.origin}/*` });
    if (!tabs.length) {
      state.screen = 'needTab';
      render();
      return;
    }
    // The tab's actual URL, not the bare origin. chrome.cookies.getAll only
    // returns a cookie when its Path is a prefix of the queried URL's path
    // (RFC 6265 path-matching) — an origin has no path, which Chrome treats
    // as "/", so querying by origin alone silently drops every cookie the
    // site scoped to something narrower (Google does this heavily). Devtools'
    // cookie panel ignores path entirely, which is why the two counts can
    // disagree. The open tab's real URL is the closest thing to "every
    // cookie this signed-in page actually depends on."
    const cookies = await chrome.cookies.getAll({ url: tabs[0].url });
    let entries = [];
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => Object.entries(window.localStorage),
      });
      entries = (injected && injected.result) || [];
    } catch {
      // The page may block script injection, or hold no localStorage —
      // cookie-only auth is common enough that this should not fail the
      // whole capture, just carry no origins entry.
      entries = [];
    }
    const storageState = buildStorageState({ cookies, origin: state.origin, localStorageEntries: entries });

    const res = await fetch(`${state.instanceUrl}/api/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ storage_state: storageState }),
    });
    state.token = '';
    if (res.status === 204) {
      state.screen = 'success';
      render();
      return;
    }
    let message = `Capture failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      // Non-JSON error body — the generic message above stands.
    }
    state.errorMsg = message;
    state.screen = 'error';
    render();
  } catch (err) {
    state.token = '';
    state.errorMsg = err && err.message ? err.message : 'Capture failed.';
    state.screen = 'error';
    render();
  }
}

function renderSuccess() {
  setApp(`
    ${header('Captured')}
    <div class="box"><p>The session for <span class="mono">${escapeHtml(state.origin)}</span> was sent to your QAssist instance.</p></div>
    <p class="muted">You can close this popup. Attach the session to a test back in QAssist.</p>
    <div class="row"><button id="again">Capture another site</button></div>
  `);
  document.getElementById('again').addEventListener('click', () => {
    state.screen = 'setup';
    state.origin = '';
    state.errorMsg = '';
    render();
  });
}

function renderError() {
  setApp(`
    ${header('Capture failed')}
    <p class="error">${escapeHtml(state.errorMsg || 'Something went wrong.')}</p>
    <p class="muted">Nothing was saved. Mint a fresh setup code in QAssist and try again.</p>
    <div class="row"><button id="restart">Start over</button></div>
  `);
  document.getElementById('restart').addEventListener('click', () => {
    state.screen = 'setup';
    state.errorMsg = '';
    render();
  });
}

function renderSettings() {
  setApp(`
    ${header('Settings')}
    <label class="check">
      <input type="checkbox" id="test-profile" ${state.isTestProfile ? 'checked' : ''} />
      <span>This browser profile is disposable / test-only — I understand any session captured here should not be a personal account.</span>
    </label>
    <p class="muted">This flag lives only in this browser profile. It gates every capture; QAssist still shows and confirms the signed-in account every single time.</p>
    <div class="row"><button class="primary" id="save">Save</button></div>
  `);
  document.getElementById('save').addEventListener('click', async () => {
    const checked = /** @type {HTMLInputElement} */ (document.getElementById('test-profile')).checked;
    state.isTestProfile = checked;
    await chrome.storage.local.set({ isTestProfile: checked });
    state.screen = state.previousScreen === 'account' ? 'account' : 'setup';
    state.previousScreen = null;
    render();
  });
}

// --- Helpers -------------------------------------------------------------

function errorBlock() {
  return state.errorMsg ? `<p class="error">${escapeHtml(state.errorMsg)}</p>` : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The reverse of the frontend's `toSetupCode` (Sessions.jsx): base64url JSON
 * of `{token, instance_url}` -> `{token, instanceUrl}`.
 * @param {string} raw
 */
function decodeSetupCode(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('empty setup code');
  const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const json = decodeURIComponent(escape(atob(padded)));
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed.token !== 'string' || typeof parsed.instance_url !== 'string') {
    throw new Error('setup code is missing token or instance_url');
  }
  return { token: parsed.token, instanceUrl: String(parsed.instance_url).replace(/\/+$/, '') };
}
