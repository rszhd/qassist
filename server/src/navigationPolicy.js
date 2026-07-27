// @ts-check
// Where a run's browser may navigate (US-042).
//
// Two halves enforce this, and they must agree. browser-use's SecurityWatchdog
// enforces the policy *inside* the browser, which is what catches a redirect
// from a permitted host to a blocked one. This module is the same judgement one
// layer earlier, so a `start_url` that was never going to be allowed costs
// neither a database row, a concurrency slot, nor a call on the caller's key.
//
// The floor is TWO settings rather than one, and that is not belt and braces.
// browser-use's docstring claims `block_ip_addresses` blocks "all IP-based URLs
// including localhost and private networks"; it does not. `localhost`, `db` and
// `metadata.google.internal` are hostnames, its `_is_ip_address` never resolves,
// and all three sail through. So address literals are one check and a hostname
// denylist is the other — and the denylist is what stands between a run and
// this app's own port.
//
// Nothing here parses an address by hand. Node's WHATWG `URL` already
// canonicalizes every spelling the story is about (`http://2852039166/` →
// `169.254.169.254`, `http://0x7f.1/` → `127.0.0.1`, percent-encoded and
// ideographic-dot forms alike), so the only correct implementation is to parse
// first and judge the canonical hostname. A check against the raw string is the
// obvious wrong answer and would pass a dotted-quad test suite.
//
// Correctness-critical: backlog/correctness-critical.md. The assertions
// (navigation-policy.test.js) were written and reviewed before this file.

/**
 * Hostnames refused by name on an instance that has not said otherwise. Every
 * entry is a thing the app container can reach and no test has any business
 * visiting: itself, the compose control plane, and the cloud metadata services
 * that answer to a name as well as to 169.254.169.254.
 */
export const DEFAULT_DENIED_HOSTS = [
  'localhost',
  'db',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
];

/** The reason vocabulary. Shared with the agent and returned to API callers. */
const REASON = {
  scheme: 'unsupported_scheme',
  ip: 'blocked_ip_address',
  host: 'blocked_host',
  allowlist: 'not_in_allowed_domains',
  malformed: 'invalid_url',
};

/**
 * @typedef {{ blockPrivate: boolean, deniedHosts: string[], allowedDomains: string[] }} Policy
 * @typedef {{ error: string, reason: string }} Refusal
 */

/** A run may only start on the two schemes a web test is about. */
const RUNNABLE_SCHEMES = new Set(['http:', 'https:']);

/**
 * The canonical hostname, or null when there isn't one we can fence. Lowercased
 * and stripped of IPv6 brackets by `URL` already; credentials, ports, paths and
 * the rest never reach the caller.
 * @param {string} url
 */
function hostOf(url) {
  try {
    const parsed = new URL(String(url).trim());
    return { scheme: parsed.protocol, host: parsed.hostname };
  } catch {
    return null;
  }
}

/**
 * True when `url`'s host is an address literal in any spelling. Delegates the
 * whole spelling problem to `URL`, which canonicalizes decimal, hex, octal,
 * short-form, percent-encoded and unicode-digit IPv4 into a dotted quad and
 * IPv6 into brackets before we look at it.
 * @param {string} url
 */
export function isAddressLiteral(url) {
  const parsed = hostOf(url);
  if (!parsed) return false;
  const { host } = parsed;
  // `URL` keeps IPv6 hosts bracketed and never brackets anything else.
  if (host.startsWith('[') && host.endsWith(']')) return true;
  // Four decimal octets is what every IPv4 spelling canonicalizes *to*, so this
  // is the only shape left to recognise — not the shapes a caller might send.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Does `host` fall under `pattern`, in browser-use's `allowed_domains`
 * vocabulary? Deliberately the same vocabulary, because the value validated
 * here is the value handed to the profile — anything else would have the
 * pre-check and the in-browser check disagree about the same string.
 * @param {string} host
 * @param {string} pattern
 */
function hostMatches(host, pattern) {
  const p = String(pattern).trim().toLowerCase();
  if (!p) return false;
  // `*.example.com` matches the apex as well as its subdomains — browser-use
  // says so in its own glob warning, and a team that allows their staging
  // domain means the domain.
  if (p.startsWith('*.')) {
    const apex = p.slice(2);
    return host === apex || host.endsWith(`.${apex}`);
  }
  if (p === '*') return true;
  return host === p;
}

/**
 * Which denylist entry covers `host`, or null. A denied name covers its
 * subdomains too — `metadata.google.internal` is not much use as a fence if
 * `anything.metadata.google.internal` walks past it.
 * @param {string} host
 * @param {string[]} deniedHosts
 */
function deniedBy(host, deniedHosts) {
  for (const raw of deniedHosts || []) {
    const denied = String(raw).trim().toLowerCase();
    if (!denied) continue;
    if (hostMatches(host, denied) || host.endsWith(`.${denied}`)) return denied;
  }
  return null;
}

/**
 * Judge one `start_url` against a resolved policy. Returns null when the run
 * may proceed, or `{ error, reason }` when it may not — prose that names the
 * URL, because whoever set the fence needs to see that it fired, and a
 * machine-readable reason so a CI caller can branch without parsing prose.
 *
 * Order is scheme, then address literal, then denied host, then the project
 * allowlist. The floor is checked BEFORE the allowlist, mirroring
 * SecurityWatchdog, so a project allowlist can never re-open an IP literal.
 * @param {string} url
 * @param {Policy} policy
 * @returns {Refusal | null}
 */
export function checkStartUrl(url, policy) {
  const parsed = hostOf(url);
  if (!parsed) {
    return {
      error: `${JSON.stringify(String(url))} is not a URL this agent can visit`,
      reason: REASON.malformed,
    };
  }
  const { scheme, host } = parsed;
  // Scheme before host, because the schemes worth refusing are exactly the ones
  // with no host to inspect: `file:`, `data:`, `blob:`, `about:`. browser-use
  // allows data: and blob: unconditionally, so delegating this to the browser
  // would leave a hole, and reporting them as malformed would hide it.
  if (!RUNNABLE_SCHEMES.has(scheme)) {
    return {
      error: `${scheme}// is not a scheme this agent can test — use http or https`,
      reason: REASON.scheme,
    };
  }
  if (!host) {
    return {
      error: `${JSON.stringify(String(url))} has no host to visit`,
      reason: REASON.malformed,
    };
  }
  if (policy.blockPrivate && isAddressLiteral(url)) {
    return {
      error:
        `navigation to ${host} is blocked: this instance does not visit IP addresses. ` +
        `Set QA_BLOCK_PRIVATE_NETWORKS=0 to allow it.`,
      reason: REASON.ip,
    };
  }
  const denied = deniedBy(host, policy.deniedHosts);
  if (denied) {
    return {
      error: `navigation to ${host} is blocked: this instance does not visit ${denied}.`,
      reason: REASON.host,
    };
  }
  const allowed = policy.allowedDomains || [];
  // Empty means "no allowlist", not "nothing is allowed" — a project that never
  // set one behaves exactly like an instance with no projects at all.
  if (allowed.length && !allowed.some((pattern) => hostMatches(host, pattern))) {
    return {
      error:
        `navigation to ${host} is blocked: this project's allowed domains are ` +
        `${allowed.join(', ')}.`,
      reason: REASON.allowlist,
    };
  }
  return null;
}

/**
 * Judge an allowlist a project is asking to store. Returns null when it is
 * storable, or `{ error }` when it is not.
 *
 * This is the write-time half of "the agent cannot reach `db` regardless of the
 * IP-literal setting", and it is load-bearing rather than tidy: when
 * `allowed_domains` is set, SecurityWatchdog returns from the allowlist branch
 * and NEVER consults `prohibited_domains`. So the in-browser denylist is not a
 * backstop for a bad allowlist — this is. An entry that would re-open the
 * instance floor is refused before it can be stored, and the whole write is
 * refused rather than filtered, so an operator is never left believing they
 * stored something they did not.
 * @param {unknown} entries
 * @param {Policy} policy
 * @returns {{ error: string } | null}
 */
export function validateAllowlist(entries, policy) {
  if (!Array.isArray(entries)) return { error: 'allowed_domains must be an array of domains' };
  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { error: 'allowed_domains entries must be non-empty domains' };
    }
    const entry = raw.trim().toLowerCase();
    if (entry === '*' || entry === '*.*' || entry === 'http://*' || entry === 'https://*') {
      return { error: `"${raw}" allows every host — remove the allowlist instead` };
    }
    // `*.com` and friends: a wildcard over a public suffix is an allowlist in
    // name only.
    if (entry.startsWith('*.') && !entry.slice(2).includes('.')) {
      return { error: `"${raw}" allows an entire top-level domain — narrow it` };
    }
    // A CIDR is not something browser-use can match at all: it would be stored
    // and then silently match nothing, which is a fence that is believed and
    // absent. Refused whatever the floor is doing.
    const probe = entry.startsWith('*.') ? entry.slice(2) : entry;
    if (probe.includes('/')) {
      return { error: `"${raw}" is a range, not a domain — allowed_domains matches hostnames` };
    }
    // An address literal is refused only while the floor is up, where such an
    // entry could never take effect and so could only mislead. With the floor
    // down — the self-hoster whose target IS their own box — `127.0.0.1` is a
    // legitimate way to confine a project, and refusing it would leave the
    // documented escape hatch only half open.
    if (policy.blockPrivate && isAddressLiteral(`http://${probe}`)) {
      return { error: `"${raw}" is an address, and this instance does not visit IP addresses` };
    }
    // And the denylist: an allowlist containing a denied host would defeat the
    // floor outright, because a set allowlist stops prohibited_domains from
    // ever being read.
    const collides = deniedBy(probe, policy.deniedHosts);
    if (collides) {
      return { error: `"${raw}" is blocked by this instance and cannot be allowed per-project` };
    }
  }
  return null;
}

/**
 * The policy as three strings for the agent's environment. The child is told
 * even when everything is off: leaving a variable unset would put the profile
 * on browser-use's own default, and its default for `block_ip_addresses` is
 * False — right by accident, which is how a fence stops being one.
 * @param {Policy} policy
 */
export function agentEnvFor(policy) {
  return {
    QA_BLOCK_PRIVATE_NETWORKS: policy.blockPrivate ? '1' : '0',
    QA_DENIED_HOSTS: (policy.deniedHosts || []).join(','),
    QA_ALLOWED_DOMAINS: JSON.stringify(policy.allowedDomains || []),
  };
}
