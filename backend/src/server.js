import { Container } from './container/Container.js';
import { createApp } from './app.js';

function boot() {
  const container = new Container();
  const app = createApp(container);
  const { host, port } = container.config;

  const server = app.listen(port, host, () => {
    console.log(`MedTwin AI backend v${container.config.appVersion}`);
    console.log(`env=${container.config.nodeEnv} db=${container.config.dbPath} llm=${container.config.llmProvider}`);
    console.log(`listening on http://${host}:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nError: Failed to start: port ${port} is already in use (${host}:${port}).`);
      console.error(`\n  Something is already listening on that port — usually a previous`);
      console.error(`  instance of this server that is still running in another terminal.`);
      console.error(`\n  Fix it in one of two ways:`);
      console.error(`\n  1. Free the port (terminates the process holding it):`);
      console.error(`       npm run kill-port`);
      console.error(`\n  2. Or start the backend on a different port:`);
      console.error(`       PORT=8081 npm start     # Windows: set PORT=8081 && npm start`);
      console.error('');
    } else if (err.code === 'EACCES') {
      console.error(`\nError: Failed to start: permission denied binding ${host}:${port}.`);
      console.error(`  Ports below 1024 need elevated privileges — use e.g. PORT=8080 npm start.\n`);
    } else {
      console.error('\nError: Server failed to start:', err);
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down gracefully`);
    server.close(() => {
      // shutdown() releases the cached Tesseract worker, then the DB.
      container.shutdown().finally(() => process.exit(0));
    });
    // hard exit guard
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

boot();
