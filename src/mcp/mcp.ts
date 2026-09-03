/**
 * /mcp — MCP Streamable HTTP endpoint (stateless JSON mode, so any Fargate
 * task behind the ALB can serve any request). Bearer-authenticated; 401s
 * carry the WWW-Authenticate pointer to the protected-resource metadata per
 * the MCP authorization spec.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { authenticate, recordManualVersion, unauthorized, type AuthContext } from '../auth/oauth.js';
import { MANUAL, SERVER_INSTRUCTIONS } from './instructions.js';
import { TOOLS, dispatchTool } from './tools.js';
import type { Config } from '../config.js';

function buildMcpServer(cfg: Config, auth: AuthContext): Server {
  const server = new Server(
    { name: 'openswitchboard', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return dispatchTool(cfg, auth.accountId, req.params.name, req.params.arguments ?? {}, {
      tokenHash: auth.tokenHash,
      manualVersion: auth.manualVersion,
      manualNotifiedAt: auth.manualNotifiedAt,
    });
  });
  return server;
}

/** initialize is where the manual is served, and so where a session begins. */
function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => (m as { method?: unknown } | null)?.method === 'initialize');
}

export function registerMcpRoutes(app: FastifyInstance, cfg: Config): void {
  app.post('/mcp', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return unauthorized(cfg, reply);

    // Note the manual this session was handed. A later sweep compares against
    // it and tells the agent what has changed, so an edit to the manual
    // reaches agents that never reconnect.
    if (isInitialize(req.body)) {
      auth.manualVersion = MANUAL.version;
      await recordManualVersion(auth.tokenHash, MANUAL.version).catch((e) => {
        req.log.warn({ err: e }, 'could not record the manual version for this session');
      });
    }

    const server = buildMcpServer(cfg, auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const methodNotAllowed = async (_req: any, reply: any) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: stateless transport' },
      id: null,
    });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
