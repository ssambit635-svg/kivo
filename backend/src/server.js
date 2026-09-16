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

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down gracefully`);
    server.close(() => {
      container.close();
      process.exit(0);
    });
    // hard exit guard
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

boot();
