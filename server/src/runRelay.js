// @ts-check
// The WebSocket side of a run: what subscribers are sent, what is buffered for
// a late viewer, and the stdin channel that tells the agent whether anyone is
// watching. Every event a run emits — spawned or replayed — leaves through
// `broadcast`.
import { MAX_CONCURRENT } from './config.js';
import { TERMINAL } from './runState.js';

function send(run, evt) {
  const data = JSON.stringify(evt);
  for (const ws of run.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Durable events are buffered for replay; screencast frames are live-only
// (we keep just the most recent one so a late viewer sees something immediately).
export function broadcast(run, evt) {
  if (evt.type === 'frame') {
    run.lastFrame = evt;
    send(run, evt);
    return;
  }
  run.events.push(evt);
  send(run, evt);
}

// A waiting run's place in the FIFO (0 = next to start). Live-only, like
// frames: it changes every time the queue drains, so replaying it out of
// `run.events` would make a late viewer watch a countdown that already
// happened. Each waiting run keeps just its current one and `attachViewer`
// sends that.
export function setQueuePosition(run, position) {
  run.queueEvent = { type: 'status', status: 'queued', position, concurrency: MAX_CONCURRENT };
  send(run, run.queueEvent);
}

// Tell the agent whether anyone is watching: it only captures screencast
// frames while a viewer is attached (saves Chromium encode CPU otherwise).
export function setScreencast(run, on) {
  const stdin = run.child?.stdin;
  if (stdin && stdin.writable) {
    stdin.write(JSON.stringify({ cmd: 'screencast', on }) + '\n');
  }
}

/**
 * Subscribe a WebSocket to a run's live feed: replay durable events, then the
 * live-only state (queue position, latest frame), then live updates follow.
 */
export function attachViewer(run, ws) {
  run.subscribers.add(ws);
  if (run.subscribers.size === 1) setScreencast(run, true);
  for (const evt of run.events) ws.send(JSON.stringify(evt));
  if (run.queueEvent) ws.send(JSON.stringify(run.queueEvent));
  if (run.lastFrame) ws.send(JSON.stringify(run.lastFrame));
  if (TERMINAL.has(run.status)) ws.send(JSON.stringify({ type: 'end', status: run.status }));
  ws.on('close', () => {
    run.subscribers.delete(ws);
    if (run.subscribers.size === 0) setScreencast(run, false);
  });
}
