/**
 * Which road the rehearsal's Claude calls take: the Claude API where the
 * rehearsal's key file is there, Bedrock where it is not or is asked for.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rehearsalAnthropicKey } from '../../rehearsal/anthropicKey.js';

const dir = mkdtempSync(join(tmpdir(), 'osb-rehearsal-key-'));
const file = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body, { mode: 0o600 });
  return p;
};

describe('rehearsalAnthropicKey', () => {
  it('reads the key file, trimmed', () => {
    expect(rehearsalAnthropicKey({ REHEARSAL_ANTHROPIC_KEY_FILE: file('k', 'test-key-value\n') })).toBe('test-key-value');
  });
  it('is undefined with no file, so the run goes through Bedrock', () => {
    expect(rehearsalAnthropicKey({ REHEARSAL_ANTHROPIC_KEY_FILE: join(dir, 'missing') })).toBeUndefined();
  });
  it('is undefined for an empty file', () => {
    expect(rehearsalAnthropicKey({ REHEARSAL_ANTHROPIC_KEY_FILE: file('e', '  \n') })).toBeUndefined();
  });
  it('is undefined when REHEARSAL_BEDROCK=1 asks for Bedrock, key or not', () => {
    expect(rehearsalAnthropicKey({ REHEARSAL_ANTHROPIC_KEY_FILE: file('b', 'test-key-value'), REHEARSAL_BEDROCK: '1' })).toBeUndefined();
  });
});
