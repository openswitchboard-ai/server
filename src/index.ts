import { loadConfig, settlementsConfigured } from './config.js';
import { initDb, migrate } from './db.js';
import { initEnvelope } from './crypto.js';
import { ensureWebhookEndpoint, initStripe } from './stripe.js';
import { initCounterKeys } from './counter/keys.js';
import { buildApp } from './app.js';
import { startScreeningWorker } from './workers/screeningWorker.js';
import { startMatchingWorker } from './workers/matchingWorker.js';
import { startOpsWorker } from './workers/opsWorker.js';
import { startEmailEventsWorker } from './workers/emailEventsWorker.js';

async function main() {
  const cfg = loadConfig();
  // The DB may still be provisioning when the first task starts (initial
  // stack create) — retry with backoff instead of crash-looping into the
  // ECS deployment circuit breaker.
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      await initDb(cfg);
      await migrate();
      break;
    } catch (e: any) {
      if (Date.now() > deadline) throw e;
      console.error(`db not ready (${e?.message}); retrying in 15s`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  initEnvelope(cfg);
  await initCounterKeys(cfg);
  initStripe(cfg);

  const app = buildApp(cfg);
  const log = (msg: string, extra?: any) => app.log.info(extra ?? {}, msg);

  if (settlementsConfigured(cfg)) {
    // Provision the Stripe webhook endpoint (idempotent). Settlements stay
    // unavailable (fail closed) until the signing secret is in hand; the
    // rest of the switchboard is unaffected by a Stripe outage at boot.
    const provision = async (attempt = 1): Promise<void> => {
      try {
        await ensureWebhookEndpoint(cfg);
        app.log.info('stripe webhook endpoint ready; settlements enabled');
      } catch (e: any) {
        app.log.error({ err: e?.message, attempt }, 'stripe webhook provisioning failed; retrying');
        setTimeout(() => void provision(attempt + 1), Math.min(60_000, 5_000 * attempt));
      }
    };
    void provision();
  } else {
    // Logged once at startup, by design: prod runs without a Stripe secret
    // until a prod Stripe account exists.
    app.log.info('settlements disabled: no Stripe secret configured for this deployment');
  }

  const stopScreening = startScreeningWorker(cfg, log);
  const stopMatching = startMatchingWorker(cfg, log);
  const stopOps = startOpsWorker(cfg, log);
  const stopEmailEvents = startEmailEventsWorker(cfg, log);

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    stopScreening();
    stopMatching();
    stopOps();
    stopEmailEvents();
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
