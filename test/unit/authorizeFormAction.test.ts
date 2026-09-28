import { describe, expect, it } from 'vitest';
import { formActionSource } from '../../src/counter/routes.js';

// 28 September 2026: Chrome applied form-action 'self' to the Authorise
// press's redirect, so the code never reached the assistant.
describe('the connect page may send its form on to the assistant', () => {
  it('names the redirect origin, or an app scheme, and nothing else', () => {
    expect(formActionSource('https://chatgpt.com/connector/oauth/abc?x=1')).toBe('https://chatgpt.com');
    expect(formActionSource('http://127.0.0.1:53682/callback')).toBe('http://127.0.0.1:53682');
    expect(formActionSource('cursor://anysphere.cursor-mcp/oauth')).toBe('cursor:');
    expect(formActionSource('not a url')).toBeUndefined();
    expect(formActionSource(undefined)).toBeUndefined();
  });
});
