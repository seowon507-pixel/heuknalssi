import { createBackend } from './app.js';
import { loadRuntimeOptions } from './runtime-bootstrap.js';

start().catch(() => {
  console.error(
    'trusted backend runtime bootstrap failed; server was not started',
  );
  process.exitCode = 1;
});

async function start() {
  const runtimeOptions = await loadRuntimeOptions();
  const backend = createBackend(runtimeOptions);
  const { server, config } = backend;

  server.listen(config.port, () => {
    console.log(`흙날씨.진단 backend-v3 listening on port ${config.port}`);
  });

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`received ${signal}; draining HTTP server`);
    server.close((error) => {
      if (error) {
        console.error('HTTP server shutdown failed');
        process.exitCode = 1;
      }
    });
    setTimeout(() => {
      console.error('HTTP server drain deadline exceeded');
      process.exitCode = 1;
      server.closeAllConnections?.();
    }, 10_000).unref();
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
