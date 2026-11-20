// Entry point: reads the environment, starts listening, shuts down cleanly.
//
//   PORT                 port to listen on (default 4000; 0 picks a free one, printed on start)
//   HOST                 interface to bind (default: all; 127.0.0.1 when embedded in another app)
//   CONFIG_PATH          config file (default: src/config/config.json next to the code); created if missing
//   API_KEY              when set, required on every endpoint except /healthz
//   DISABLE_ADMIN        1 = no /admin page and no /admin/* endpoints
//   DISABLE_SEARCH_UI    1 = no /search-ui page
//   EXIT_ON_STDIN_CLOSE  1 = exit when stdin closes (the parent process went away)

const { createConfigStore, resolveConfigPath } = require('../lib/config');
const { createApp } = require('./app');

function start(env = process.env) {
  let store;
  try {
    store = createConfigStore({ file: resolveConfigPath(env) });
  } catch (err) {
    console.error('Failed to load config, exiting:', err.message);
    process.exit(1);
  }

  const { app, warmUp } = createApp({ store, env });
  const port = env.PORT === undefined || env.PORT === '' ? 4000 : Number(env.PORT);
  const host = (env.HOST || '').trim() || undefined;

  const server = app.listen(port, host, () => {
    const addr = server.address();
    const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    console.log(`Backbone listening on http://${shown}:${addr.port} (config: ${store.file})`);
    // Load the provider modules after the port is open, so the first health check is not kept waiting.
    setImmediate(warmUp);
  });
  server.on('error', (err) => {
    console.error(`Cannot listen on ${host || '*'}:${port}: ${err.message}`);
    process.exit(1);
  });

  let closing = false;
  function shutdown(reason) {
    if (closing) return;
    closing = true;
    console.log(`Shutting down (${reason})`);
    server.close(() => process.exit(0));
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    // Requests still running get a moment, then the process goes anyway.
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (/^(1|true|yes|on)$/i.test(String(env.EXIT_ON_STDIN_CLOSE || '').trim())) {
    process.stdin.on('end', () => shutdown('stdin closed'));
    process.stdin.on('error', () => shutdown('stdin closed'));
    process.stdin.resume();
  }

  // A stray rejection in a provider must not take the server down.
  process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err && err.message ? err.message : err));

  return server;
}

if (require.main === module) start();

module.exports = { start };
