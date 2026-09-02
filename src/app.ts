import Fastify, { FastifyInstance } from 'fastify';
import { registerOAuthRoutes } from './auth/oauth.js';
import { registerMcpRoutes } from './mcp/mcp.js';
import { registerCounterRoutes } from './counter/routes.js';
import { registerPublicRoutes } from './publicApi.js';
import { registerStripeWebhook } from './stripeWebhook.js';
import { SCHEMA_NAMES, SCHEMA_VERSION, validatePayload } from './protocol.js';
import { settlementsConfigured, type Config } from './config.js';

/** The path part of a raw request URL, without its query string. */
function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function buildApp(cfg: Config): FastifyInstance {
  const app = Fastify({
    logger: true,
    trustProxy: true, // behind the ALB
    bodyLimit: 256 * 1024,
  });

  // application/x-www-form-urlencoded for the OAuth login form + token endpoint.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (e: any) {
        done(e);
      }
    },
  );

  app.get('/healthz', async () => ({
    ok: true,
    service: 'openswitchboard-server',
    env: cfg.envName,
    schema_version: SCHEMA_VERSION,
  }));

  // Conformance validation endpoint: exposes this deployment's validators so
  // the schema repo's runConformance() can be pointed at the live service.
  app.post('/conformance/validate', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!SCHEMA_NAMES.includes(b.schema)) {
      return reply.code(400).send({ error: `unknown schema '${b.schema}'` });
    }
    return validatePayload(b.schema, b.data);
  });

  // Host separation (defence-in-depth on top of the route-class guards):
  // /mcp is never served on the human hostname, and the human page class is
  // never served on the MCP hostname (enforced inside the counter plugin).
  // The human pages now own the root of their own hostname, so the MCP host's
  // own root is answered here rather than by a route (the human page class
  // registers '/' too, and only one of them can be a route).
  const counterHost = new URL(cfg.counterOrigin).host.toLowerCase();
  const mcpHost = new URL(cfg.publicOrigin).host.toLowerCase();
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if ((req.url.startsWith('/mcp') || req.url.startsWith('/stripe')) && host === counterHost) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (host === mcpHost && pathOf(req.url) === '/') {
      return reply
        .type('text/plain')
        .send(`OpenSwitchboard ${cfg.envName} switchboard. MCP endpoint: ${cfg.publicOrigin}/mcp\n`);
    }
    // The move off counter[-dev].openswitchboard.ai and off the /counter path
    // prefix, held open for links already in people's inboxes. Both are
    // permanent redirects to the same page on the new hostname, so an approval
    // link emailed last month still lands on the thing it names. The MCP host
    // is left alone: nothing human was ever served there.
    if (host !== mcpHost) {
      const legacyHost = cfg.legacyCounterHosts.includes(host);
      const path = pathOf(req.url);
      const legacyPath = path === '/counter' || path.startsWith('/counter/');
      if (legacyHost || legacyPath) {
        const rest = legacyPath ? req.url.slice('/counter'.length) : req.url;
        const target = rest.startsWith('/') ? rest : `/${rest}`;
        return reply.redirect(legacyHost ? `${cfg.counterOrigin}${target}` : target, 308);
      }
    }
  });

  registerOAuthRoutes(app, cfg);
  registerPublicRoutes(app, cfg);
  registerMcpRoutes(app, cfg);
  registerCounterRoutes(app, cfg);
  // Settlement webhook exists ONLY on deployments with Stripe configured;
  // everywhere else the route is absent and answers 404.
  if (settlementsConfigured(cfg)) registerStripeWebhook(app, cfg);
  return app;
}
