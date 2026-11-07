import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { OPENAI_APPS_CHALLENGE, registerMcpRoutes } from '../../src/mcp/mcp.js';
import { toolsFor } from '../../src/mcp/tools.js';

describe('the public server card', () => {
  it('lists the tools this deployment serves, with no account', async () => {
    const cfg: any = { envName: 'prod', sealedContact: false };
    const app = Fastify();
    registerMcpRoutes(app, cfg);
    const res = await app.inject({ method: 'GET', url: '/.well-known/mcp/server-card.json' });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.serverInfo.name).toBe('openswitchboard');
    expect(card.authentication).toEqual({ required: true, schemes: ['oauth2'] });
    expect(card.tools.map((t: any) => t.name)).toEqual(toolsFor(cfg).map((t) => t.name));
    expect(card.tools.every((t: any) => t.description && t.inputSchema)).toBe(true);
    await app.close();
  });

  it("serves OpenAI's domain challenge as the bare token", async () => {
    const app = Fastify();
    registerMcpRoutes(app, { envName: 'prod', sealedContact: false } as any);
    const res = await app.inject({ method: 'GET', url: '/.well-known/openai-apps-challenge' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe(OPENAI_APPS_CHALLENGE);
    await app.close();
  });
});
