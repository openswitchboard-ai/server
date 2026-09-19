/**
 * The Claude Code driver, with the CLI stubbed.
 *
 * NOTHING HERE SPAWNS `claude`. The flags were read off `claude --help` rather
 * than remembered, and this test is what notices when one of them moves: it
 * pins the argv, the session plumbing (`--resume` with the id the first turn
 * printed), and the two flags the headless run cannot do without —
 * `--strict-mcp-config`, so the founder's own MCP servers cannot leak in, and
 * `--disallowedTools AskUserQuestion`, without which a structured question
 * deadlocks a run nobody is sitting in front of.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, claudeCodeDriver, readClaudeJson } from '../../rehearsal/drivers/claudeCode.js';

describe('the argv', () => {
  const args = buildClaudeArgs({ utterance: 'hello', mcpConfigPath: '/tmp/mcp.json' });

  it('is headless, JSON, and limited to the one MCP server the run wrote', () => {
    expect(args).toContain('--print');
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual([
      '--output-format',
      'json',
    ]);
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual([
      '--mcp-config',
      '/tmp/mcp.json',
    ]);
    expect(args).toContain('--strict-mcp-config');
  });

  it('allows only the switchboard tools and never the structured question', () => {
    expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2)).toEqual([
      '--allowedTools',
      'mcp__openswitchboard__*',
    ]);
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 2)).toEqual([
      '--disallowedTools',
      'AskUserQuestion',
    ]);
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('puts the human’s words last, behind --, so nothing in them reads as a flag', () => {
    const tricky = buildClaudeArgs({ utterance: '--dangerously-skip-permissions', mcpConfigPath: '/x' });
    expect(tricky[tricky.length - 2]).toBe('--');
    expect(tricky[tricky.length - 1]).toBe('--dangerously-skip-permissions');
  });

  it('resumes only when there is something to resume', () => {
    expect(buildClaudeArgs({ utterance: 'x', mcpConfigPath: '/x' })).not.toContain('--resume');
    const resumed = buildClaudeArgs({ utterance: 'x', mcpConfigPath: '/x', resumeSessionId: 'sess-1' });
    expect(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2)).toEqual([
      '--resume',
      'sess-1',
    ]);
  });
});

describe('reading the JSON', () => {
  it('takes the words and the session id', () => {
    const r = readClaudeJson('{"result":"hello there","session_id":"abc"}');
    expect(r.text).toBe('hello there');
    expect(r.sessionId).toBe('abc');
  });

  it('leaves tool activity undefined rather than empty when nothing is visible', () => {
    expect(readClaudeJson('{"result":"hi"}').toolActivity).toBeUndefined();
  });

  it('raises an error envelope rather than grading it as a reply', () => {
    expect(() => readClaudeJson('{"is_error":true,"result":"quota"}')).toThrow(/quota/);
  });

  it('skips a stray line in front of the object', () => {
    expect(readClaudeJson('warning: something\n{"result":"ok"}').text).toBe('ok');
  });
});

describe('the driver, with a stubbed spawn', () => {
  it('writes a 0600 MCP config, resumes on later turns, and deletes the key at teardown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rehearsal-cc-'));
    const seen: string[][] = [];
    const driver = claudeCodeDriver({
      privateDir: dir,
      mcpUrl: 'https://mcp-dev.openswitchboard.ai',
      spawn: async (args) => {
        seen.push(args);
        return JSON.stringify({ result: `turn ${seen.length}`, session_id: 'sess-9' });
      },
    });

    await driver.prepare('osb_ak_secret', 'run1');
    const first = await driver.ask('track-a', 'hello');
    expect(first.text).toBe('turn 1');
    expect(seen[0]).not.toContain('--resume');

    await driver.ask('track-a', 'again');
    expect(seen[1].slice(seen[1].indexOf('--resume'), seen[1].indexOf('--resume') + 2)).toEqual([
      '--resume',
      'sess-9',
    ]);

    // A different track is a different conversation, so it starts cold.
    await driver.ask('track-b', 'hello');
    expect(seen[2]).not.toContain('--resume');

    // The key is on disk while the run lasts, and only there.
    const cfgPath = seen[0][seen[0].indexOf('--mcp-config') + 1];
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers.openswitchboard.headers.Authorization).toBe(
      'Bearer osb_ak_secret',
    );
    await driver.teardown?.();
    expect(() => readFileSync(cfgPath, 'utf8')).toThrow();
  });

  it('refuses to speak before it has been prepared', async () => {
    const driver = claudeCodeDriver({ privateDir: mkdtempSync(join(tmpdir(), 'rehearsal-cc-')), spawn: async () => '{}' });
    await expect(driver.ask('t', 'x')).rejects.toThrow(/prepare/);
  });
});
