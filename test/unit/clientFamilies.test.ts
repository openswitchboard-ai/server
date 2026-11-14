import { describe, expect, it } from 'vitest';
import { baselineHash, DESCRIPTION_OVERRIDES, familyOf } from '../../src/mcp/clientFamilies.js';
import { TOOLS, toolsFor } from '../../src/mcp/tools.js';

const cfg: any = { sealedContact: true };

describe('tool descriptions per family of assistant', () => {
  it('tells families apart by redirect host first, then by name', () => {
    expect(familyOf('Anything', ['https://chatgpt.com/connector/oauth/abc'])).toBe('chatgpt');
    expect(familyOf('ChatGPT', ['https://example.com/cb'])).toBe('chatgpt');
    expect(familyOf('Claude', ['https://claude.ai/api/mcp/auth_callback'])).toBe('claude');
    expect(familyOf('Claude Code (openswitchboard)', ['http://localhost:51234/callback'])).toBe('claude');
    expect(familyOf('Gemini CLI', ['http://127.0.0.1:7777/cb'])).toBe('gemini');
    expect(familyOf('Antigravity', ['http://127.0.0.1:7777/cb'])).toBe('gemini');
    expect(familyOf('OpenClaw', ['http://127.0.0.1:7777/cb'])).toBe('openclaw');
    expect(familyOf('osb-integration-suite', ['http://127.0.0.1:47391/cb'])).toBe('default');
    // A name cannot claim a host it does not redirect to.
    expect(familyOf('Claude', ['https://chatgpt.com/connector/oauth/x'])).toBe('chatgpt');
  });

  it('every override names a real tool and was written against the baseline served today', () => {
    const baseline = new Map(TOOLS.map((t) => [t.name, t.description]));
    for (const [family, overrides] of Object.entries(DESCRIPTION_OVERRIDES)) {
      for (const [tool, o] of Object.entries(overrides)) {
        expect(baseline.has(tool), `${family}.${tool}: no such tool`).toBe(true);
        expect(
          o.baseline,
          `${family}.${tool} was written against an older baseline: review it against the new one, then update its hash to ${baselineHash(baseline.get(tool)!)}`,
        ).toBe(baselineHash(baseline.get(tool)!));
        expect(o.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('ChatGPT gets its own wording for every tool, with no order-giving capitals', () => {
    const chat = toolsFor(cfg, 'chatgpt');
    const base = toolsFor(cfg);
    expect(chat.map((t) => t.name)).toEqual(base.map((t) => t.name));
    for (const t of chat) {
      expect(t.description, t.name).not.toBe(base.find((b) => b.name === t.name)!.description);
      expect(t.description, t.name).not.toMatch(/\b(NEVER|ALWAYS|ASK|SAY|POST|ONLY|WRITE|REACH)\b/);
      expect(t.inputSchema).toBe(base.find((b) => b.name === t.name)!.inputSchema);
    }
  });

  it('a family with no overrides gets the baseline exactly', () => {
    expect(toolsFor(cfg, 'gemini')).toEqual(toolsFor(cfg));
    expect(toolsFor(cfg, 'default')).toEqual(toolsFor(cfg));
  });

  it("Claude ends its reply with the link and waits only once the person says they pressed", () => {
    const base = toolsFor(cfg);
    const claude = toolsFor(cfg, 'claude');
    // The tools whose answer is a page to hand over (the trade tools since
    // 14 November 2026).
    const handing = ['respond', 'wait_for_press', 'propose_trade', 'answer_trade'];
    for (const name of handing) {
      const d = claude.find((x) => x.name === name)!.description;
      expect(d, name).not.toBe(base.find((b) => b.name === name)!.description);
      expect(d, name).toContain('folded out of sight');
    }
    expect(claude.filter((t) => !handing.includes(t.name))).toEqual(base.filter((t) => !handing.includes(t.name)));
  });

  it('serves an override only while its baseline is current, and falls back otherwise', () => {
    const t = TOOLS.find((x) => x.name === 'read_manual')!;
    const saved = { ...DESCRIPTION_OVERRIDES.gemini };
    try {
      DESCRIPTION_OVERRIDES.gemini.read_manual = { baseline: baselineHash(t.description), description: 'Gemini words.' };
      expect(toolsFor(cfg, 'gemini').find((x) => x.name === 'read_manual')!.description).toBe('Gemini words.');
      expect(toolsFor(cfg, 'claude').find((x) => x.name === 'read_manual')!.description).toBe(t.description);
      DESCRIPTION_OVERRIDES.gemini.read_manual = { baseline: 'stale0000000', description: 'Gemini words.' };
      expect(toolsFor(cfg, 'gemini').find((x) => x.name === 'read_manual')!.description).toBe(t.description);
    } finally {
      DESCRIPTION_OVERRIDES.gemini = saved;
    }
  });
});
