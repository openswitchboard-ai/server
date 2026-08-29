import { loadConfig } from './config.js';
import { initDb, migrate } from './db.js';
import { initEnvelope } from './crypto.js';
import { buildApp } from './app.js';
import { startScreeningWorker } from './workers/screeningWorker.js';
import { startOpsWorker } from './workers/opsWorker.js';

async function main() {
  const cfg = loadConfig();
  await initDb(cfg);
  await migrate();
  initEnvelope(cfg);

  const app = buildApp(cfg);
  const log = (msg: string, extra?: any) => app.log.info(extra ?? {}, msg);

  const stopScreening = startScreeningWorker(cfg, log);
  const stopOps = startOpsWorker(cfg, log);

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    stopScreening();
    stopOps();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info({ env: cfg.envName, port: cfg.port }, 'openswitchboard server up');
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
