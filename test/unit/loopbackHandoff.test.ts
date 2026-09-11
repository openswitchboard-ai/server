/**
 * Loopback handoff page: when the agent's local listener does not answer,
 * the page must hand the person the full callback link (what Claude Code
 * and most CLIs ask for), with the bare code as a secondary option.
 */
import { describe, expect, it } from 'vitest';
import { loopbackHandoffPage } from '../../src/counter/pages.js';

const CALLBACK = 'http://localhost:63554/callback?code=abc123&state=xyz<>';
const CODE = 'abc123';

describe('loopbackHandoffPage', () => {
  const html = loopbackHandoffPage({ callbackUrl: CALLBACK, code: CODE, clientName: 'Claude <Code>' });

  it('shows the full callback link, escaped, with a copy button', () => {
    expect(html).toContain('http://localhost:63554/callback?code=abc123&amp;state=xyz&lt;&gt;');
    expect(html).toContain('id="copyurl"');
    expect(html).toContain('paste this link where it asks');
    expect(html).not.toContain('Claude <Code>');
  });

  it('still tries the local listener first and copies the exact URL', () => {
    expect(html).toContain(`fetch(${JSON.stringify(CALLBACK)}, { mode: 'no-cors' })`);
    expect(html).toContain(`copier('copyurl', ${JSON.stringify(CALLBACK)})`);
  });

  it('keeps the bare code folded behind a disclosure', () => {
    const codeAt = html.indexOf('id="codebox"');
    const urlAt = html.indexOf('id="urlbox"');
    expect(urlAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(urlAt);
    expect(html.slice(urlAt, codeAt)).toContain('<details class="more"');
    expect(html).toContain(`copier('copybtn', ${JSON.stringify(CODE)})`);
  });
});
