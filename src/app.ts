import Fastify, { FastifyInstance } from 'fastify';
import { registerOAuthRoutes } from './auth/oauth.js';
import { registerMcpRoutes } from './mcp/mcp.js';
import { SCHEMA_NAMES, SCHEMA_VERSION, validatePayload } from './protocol.js';
import type { Config } from './config.js';

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

  app.get('/', async (_req, reply) =>
    reply.type('text/plain').send(
      `OpenSwitchboard ${cfg.envName} switchboard. MCP endpoint: ${cfg.publicOrigin}/mcp\n`,
    ),
  );

  // Conformance validation endpoint: exposes this deployment's validators so
  // the schema repo's runConformance() can be pointed at the live service.
  app.post('/conformance/validate', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!SCHEMA_NAMES.includes(b.schema)) {
      return reply.code(400).send({ error: `unknown schema '${b.schema}'` });
    }
    return validatePayload(b.schema, b.data);
  });

  registerOAuthRoutes(app, cfg);
  registerMcpRoutes(app, cfg);
  return app;
}
