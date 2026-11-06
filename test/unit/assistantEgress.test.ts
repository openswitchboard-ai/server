import { describe, expect, it } from 'vitest';
import { assistantPlatformOf } from '../../src/auth/assistantEgress.js';

describe('which assistant platform an address belongs to', () => {
  it("knows both of Anthropic's outbound ranges, edge to edge", () => {
    for (const ip of ['160.79.104.0', '160.79.111.255', '153.61.208.1', '153.61.223.254']) {
      expect(assistantPlatformOf(ip), ip).toBe('anthropic');
    }
  });

  it('knows an address on the OpenAI connectors list', () => {
    expect(assistantPlatformOf('98.87.72.221')).toBe('openai');
    expect(assistantPlatformOf('104.208.184.200')).toBe('openai');
  });

  it('reads an IPv4 address seen through a dual-stack socket', () => {
    expect(assistantPlatformOf('::ffff:160.79.104.9')).toBe('anthropic');
  });

  it('says nothing for anybody else, or for nonsense', () => {
    for (const ip of ['160.79.112.0', '153.61.224.1', '203.0.113.7', '2607:6bc0::1', '', 'nonsense', undefined]) {
      expect(assistantPlatformOf(ip as string | undefined), String(ip)).toBeUndefined();
    }
  });
});
