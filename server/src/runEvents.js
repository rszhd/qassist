// @ts-check
// The NDJSON protocol, in the one place a tool can check it.
//
// `run_agent.py` writes these on stdout, `runs.js` parses them, `runRelay.js`
// forwards them over the WebSocket and the viewer renders them — four
// boundaries, and until this file none of them agreed by anything stronger than
// two docstrings. Types only: there is no runtime here and there should not be,
// because the wire format has no representation to construct. The agent is the
// author, so a change starts in `run_agent.py` and lands here in the same
// commit; the shapes are documented HERE and pointed at from there and from
// `docs/architecture.md`, never restated.
//
// A few of these never touch Python — the server mints `status`, `stopping` and
// `end` itself, and `runReplay.js` re-emits fixture events through the same
// relay. They live here anyway: what the viewer reads off one socket is one
// union, and splitting it by who happened to write it would hide exactly the
// mismatches this file exists to catch.
//
// This is the bottom of the engine's import order, so nothing here may name
// anything from the modules above it. That is why `RunStatus` is declared
// below rather than borrowed from `runState.js`: `end` puts it on the wire, so
// the wire is where the vocabulary belongs, and `Run.status` reads it back
// from here.

/**
 * A run's status, everywhere. Five of the seven are terminal — the set itself
 * is `TERMINAL` in `runState.js`, which is where a status is decided; this is
 * only the vocabulary.
 * @typedef {'queued' | 'running' | 'passed' | 'failed' | 'completed' | 'error'
 *          | 'cancelled'} RunStatus
 */

/**
 * The run begins. First durable event; `model` is what the run actually used,
 * which is not necessarily what the test asked for.
 * @typedef {{ type: 'start', goal: string, start_url: string, model: string }} StartEvent
 */

/**
 * One CDP screencast frame, base64 JPEG, ~6 fps and only while a viewer is
 * attached. The one non-durable event — `broadcast` keeps the latest and drops
 * the rest, so `data` never accumulates in `run.events`.
 * @typedef {{ type: 'frame', data: string }} FrameEvent
 */

/**
 * One agent reasoning step. `screenshot_file` is a bare filename inside
 * `runs/<runId>/`, null when the shot could not be written — which is why the
 * report renders a placeholder rather than assuming a file.
 *
 * `elapsed` and `video_seconds` are two different clocks and neither converts
 * to the other (US-076). `elapsed` is wall-clock seconds since the run started
 * and is what a row shows. `video_seconds` is where this step begins inside
 * `recording.mp4`, which holds only the frames Chromium repainted — so the two
 * drift apart by however long the run sat waiting. It is null when the run was
 * not recorded, and absent on every run recorded before US-076; a reader with
 * neither offers no seek rather than falling back to `elapsed`.
 * @typedef {{ type: 'step', step: number, elapsed: number, url: string | null,
 *             evaluation: string | null, next_goal: string | null,
 *             thinking: string | null, screenshot_file: string | null,
 *             video_seconds?: number | null }} StepEvent
 */

/**
 * One finding the browser reported (US-044), already scrubbed, capped and
 * deduplicated by `diagnostics.py`. `step` is null for anything that happened
 * before step 1 — a page's own load errors do — which is why both renderers
 * group by it rather than hanging findings off a step object.
 * @typedef {{ kind: 'request', step: number | null, url: string, status: number, count: number }
 *          | { kind: 'console', step: number | null, level: string, text: string, count: number }
 *          | { kind: 'exception', step: number | null, text: string, count: number }} Diagnostic
 */

/**
 * A batch of findings, one event per step boundary — never one per console
 * line, which is what keeps the pipe from backing up.
 *
 * `dropped` is the run total so far, not this batch's: each event carries the
 * tally to date, so the last one to arrive is the whole answer and summing them
 * multiplies it by the number of steps.
 * @typedef {{ type: 'diagnostics', entries: Diagnostic[], dropped: number }} DiagnosticsEvent
 */

/**
 * The navigation fence refused a URL (US-042). Emitted per distinct URL, at
 * most once — `step` is absent for a block found in the final sweep, which has
 * no step to attribute it to.
 * @typedef {{ type: 'blocked', url: string, reason: 'navigation_blocked',
 *             step?: number }} BlockedEvent
 */

/**
 * The deterministic actions that ran before step 1 (US-043). `actions` is the
 * action names alone, so the viewer can say what ran without the arguments —
 * which may be secrets.
 * @typedef {{ type: 'preamble', actions: string[], count: number }} PreambleEvent
 */

/**
 * The mp4 is finalized. Always precedes `done`/`error`, so the report can link
 * it. `demo: true` with no file is `runReplay.js` announcing a fixture's
 * recording: the stage plays it as the live feed, since a replayed run has no
 * screencast of its own.
 * @typedef {{ type: 'recording', file?: string, frames?: number,
 *             demo?: boolean }} RecordingEvent
 */

/**
 * Terminal, and the agent's self-report — not the verdict. The server decides
 * that (`verdictOf`), because a stopped run still ends up here carrying
 * `success` from browser-use's history.
 *
 * `success` is null when the agent reached no judgement at all.
 * `failure_reason` is null on every ordinary run, which is what keeps a value
 * meaning "a fence fired" rather than "something went wrong".
 * @typedef {{ type: 'done', success: boolean | null, steps: number,
 *             duration_seconds: number | null, final_result: string | null,
 *             errors: string[], urls?: string[],
 *             failure_reason?: string | null,
 *             blocked_url?: string | null }} DoneEvent
 */

/**
 * Terminal: the run crashed, or the server killed it. `failure_reason` and
 * `blocked_url` ride along when the fence was the cause.
 * @typedef {{ type: 'error', message: string, failure_reason?: string | null,
 *             blocked_url?: string | null }} ErrorEvent
 */

/**
 * Free-text notes, all three durable and none carrying a step number — so none
 * of them reaches the report, which keys its step section on one.
 * `progress` is written for a human watching the stage (waiting on a
 * confirmation email); `log` also catches a stdout line that would not parse as
 * JSON at all; `warn` is the agent degrading rather than failing.
 * @typedef {{ type: 'progress' | 'log' | 'warn', message: string }} MessageEvent
 */

/**
 * The server's own: a run started, or is waiting.
 *
 * The two are one `type` but not one shape, and they are kept apart because
 * only `QueuedEvent` is ever stored — `run.queueEvent` holds the current
 * position and nothing else, so typing that slot as the pair would make
 * `.position` optional at the one place it is guaranteed. Queue position is
 * live-only: `runRelay.js` keeps the latest per run rather than buffering the
 * series, so a late viewer sees where the run is now instead of watching a
 * countdown that already finished.
 * @typedef {{ type: 'status', status: 'running' }} RunningEvent
 * @typedef {{ type: 'status', status: 'queued', position: number,
 *             concurrency: number }} QueuedEvent
 * @typedef {RunningEvent | QueuedEvent} StatusEvent
 */

/**
 * The server's own: a stop was asked for (US-047). Says the request landed —
 * the run is still running until its process ends.
 * @typedef {{ type: 'stopping' }} StoppingEvent
 */

/**
 * The server's own, and the last event on the socket. `status` is the resolved
 * terminal status, `code` the child's exit code when there was a child to
 * exit, `demo: true` when a replay ended.
 * @typedef {{ type: 'end', status: RunStatus, code?: number | null,
 *             demo?: boolean }} EndEvent
 */

/**
 * Everything that can cross the socket. Discriminated on `type`, so a `switch`
 * or a `.filter(e => e.type === 'step')` narrows to the one shape.
 * @typedef {StartEvent | FrameEvent | StepEvent | DiagnosticsEvent | BlockedEvent
 *          | PreambleEvent | RecordingEvent | DoneEvent | ErrorEvent | MessageEvent
 *          | StatusEvent | StoppingEvent | EndEvent} RunEvent
 */

/**
 * Server → agent, line-delimited on the child's stdin.
 * @typedef {{ cmd: 'screencast', on: boolean } | { cmd: 'stop' }} ControlCommand
 */
