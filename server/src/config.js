// @ts-check
// Central env config, read once at import time (tests set env before
// importing the app).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = parseInt(process.env.PORT || '8080', 10);
export const API_TOKEN = process.env.WORKER_API_TOKEN || '';
export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '4', 10);
export const DEFAULT_MAX_STEPS = parseInt(process.env.MAX_STEPS || '60', 10);
export const RUN_TTL_MS = parseInt(process.env.RUN_TTL_SECONDS || '3600', 10) * 1000;
export const MAX_RUN_MEMORY_MB = parseInt(process.env.MAX_RUN_MEMORY_MB || '1200', 10);
export const MEM_POLL_MS = 3000;
export const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
export const AGENT_DIR = process.env.AGENT_DIR || path.join(__dirname, '..', '..', 'agent');
export const AGENT_SCRIPT = process.env.AGENT_SCRIPT || path.join(AGENT_DIR, 'run_agent.py');
export const REPORT_SCRIPT = process.env.REPORT_SCRIPT || path.join(AGENT_DIR, 'make_report.py');
export const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(__dirname, '..', '..', 'runs');
export const MODEL = process.env.BROWSER_USE_MODEL || 'gpt-4.1';
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Where this instance is reachable from outside (US-007 sets it). The PDF
// report needs an absolute URL to link a recording; unset = no link in the
// PDF, the recording is still served in-app.
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
export const RECORDING_FILENAME = 'recording.mp4';

// The agent can't run without a model key. Checked up front so a missing key
// is a clear message at startup and on POST, not a Python traceback ~15s into
// the first run. US-005 (BYOK) will extend this to per-request/stored keys.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Control plane (US-009). No DATABASE_URL = legacy in-memory mode: ad-hoc
// runs work, saved tests/suites respond 503.
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'operator@qassist.local';
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'db', 'migrations');
