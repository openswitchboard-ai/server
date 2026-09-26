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
import { settlementsConfigured, type Config } from '../config.js';
import { ownHumanBlock, suspendedBlock } from './connectFacts.js';

export const SETTLEMENT_OFF_BLOCK =
  'THIS DEPLOYMENT, TODAY\nPaying through the switchboard is not on here yet (settle answers SETTLEMENT_UNAVAILABLE): paying is between the two humans for now, and anyone claiming the switchboard holds money is lying.';

/**
 * The manual, plus the two kinds of fact that cannot wait for a tool call.
 *
 * First this deployment's own: the manual describes settle's happy path, and
 * whether that path is switched on is deployment state, so an agent that only
 * learns it by calling settle will meanwhile describe an escrow that does not
 * exist to a human weighing a payment.
 *
 * Then this agent's own human: their area and their clock, for the same
 * reason one step further in. An assistant told "sell my bike" asks its human
 * which suburb before it ever calls the switchboard, so a fact carried by the
 * sweep arrives after the question. Both blocks ride outside the versioned
 * text, like an arrangement note.
 *
 * `accountId` is passed only for the handshake that serves the manual, so an
 * ordinary tool call costs no identity read and writes no audit line. The
 * human block is fail-soft to the point of silence: see connectFacts.ts.
 */
export async function instructionsFor(
  cfg: Config,
  opts: { accountId?: string; onError?: (err: unknown) => void } = {},
): Promise<string> {
  // THE CORE GOES FIRST NOW, and the blocks follow it. The manual used to be
  // fifty-three thousand characters, so anything appended to it sat at 99% of
  // a text most clients had already cut off; these blocks went in front of it
  // for that reason. The core is a thousand characters, every client delivers
  // the whole of it, and what never bends belongs at the top of it.
  //
  // The one thing that still goes ahead of everything: this account is
  // suspended. Nothing under the other headings is work this agent will be
  // doing, so an agent that reads a suburb and a clock first starts composing
  // a posting before it reaches the sentence that matters — and on a stopped
  // account their own facts are not served at all, for the same reason and to
  // keep the whole string inside CONNECT_TEXT_CAP.
  const blocks: string[] = [];
  let stopped = '';
  if (opts.accountId) {
    stopped = await suspendedBlock(opts.accountId, { onError: opts.onError });
    if (stopped) blocks.push(stopped);
  }
  blocks.push(SERVER_INSTRUCTIONS);
  if (opts.accountId && !stopped) {
    const own = await ownHumanBlock(opts.accountId, { onError: opts.onError });
    if (own) blocks.push(own);
  }
  if (!settlementsConfigured(cfg)) blocks.push(SETTLEMENT_OFF_BLOCK);
  return blocks.join('\n\n');
}

async function buildMcpServer(
  cfg: Config,
  auth: AuthContext,
  opts: { serveOwnFacts: boolean; onError?: (err: unknown) => void },
): Promise<Server> {
  const server = new Server(
    { name: 'openswitchboard', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: await instructionsFor(cfg, {
        ...(opts.serveOwnFacts ? { accountId: auth.accountId } : {}),
        ...(opts.onError ? { onError: opts.onError } : {}),
      }),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Which tool was called, and nothing else: no arguments, no account. It is
    // the only way to tell whether assistants read the manual before they act
    // (read_manual's section is a public table-of-contents word, so it rides
    // along), and a rule nobody fetched is a different problem from a rule
    // somebody read and ignored.
    const called = String(req.params.name ?? '');
    const section =
      called === 'read_manual' ? String((req.params.arguments as any)?.section ?? 'start').slice(0, 40) : undefined;
    console.log(JSON.stringify({ level: 30, time: Date.now(), msg: 'tool call', tool: called.slice(0, 40), ...(section ? { section } : {}) }));
    return dispatchTool(cfg, auth.accountId, req.params.name, req.params.arguments ?? {}, {
      tokenHash: auth.tokenHash,
      manualVersion: auth.manualVersion,
      manualNotifiedAt: auth.manualNotifiedAt,
      manualStartSentAt: auth.manualStartSentAt,
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
    const initializing = isInitialize(req.body);
    if (initializing) {
      auth.manualVersion = MANUAL.version;
      await recordManualVersion(auth.tokenHash, MANUAL.version).catch((e) => {
        req.log.warn({ err: e }, 'could not record the manual version for this session');
      });
    }

    const server = await buildMcpServer(cfg, auth, {
      serveOwnFacts: initializing,
      onError: (err) =>
        req.log.warn({ err }, "could not read this human's own facts for the connect manual"),
    });
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
