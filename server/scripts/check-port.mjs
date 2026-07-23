// Refuse a second `npm run dev` before there is a watcher to linger.
//
// `node --watch` does not exit when its child dies of EADDRINUSE — it waits
// for the next file change and restarts. So a duplicate dev server becomes a
// permanent watcher, and every save afterwards has all of them racing to bind
// the port; whichever wins may have loaded an older module graph, which is how
// a saved change ends up served by stale code. `predev` runs before the
// watcher exists, so failing here is what keeps that from happening at all.
//
// A plain bind probe rather than ss/lsof: this has to work wherever the dev
// server does, and the desktop track (US-016) means not assuming Linux.
import net from 'node:net';

const port = Number(process.env.PORT || 8081);
const probe = net.createServer();

probe.once('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\n  :${port} is already in use — a dev server is already running.`);
  console.error('  Find it and kill it by PID (never by pattern — other servers share the name):');
  console.error(`    ss -lptn 'sport = :${port}'                 # linux`);
  console.error(`    lsof -nP -iTCP:${port} -sTCP:LISTEN         # macos\n`);
  process.exit(1);
});
probe.once('listening', () => probe.close());
probe.listen(port);
