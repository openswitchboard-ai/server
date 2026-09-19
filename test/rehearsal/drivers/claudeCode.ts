/**
 * THE THIRD ASSISTANT: Claude Code, headless, on this laptop.
 *
 * WHY IT IS HERE AND NOT JUST THE TWO OPENCLAW AGENTS. The acceptance test the
 * founder will actually run has his own Claude Code session on one side. Claude
 * Code and OpenClaw read the switchboard's connect instructions DIFFERENTLY —
 * Claude Code truncates them at roughly two thousand characters, OpenClaw
 * ignores them altogether — and the whole reason the manual moved into
 * read_manual sections was that truncation. So "the assistant read the manual"
 * is a question with a different answer per client, and a suite that only ever
 * drives OpenClaw cannot ask it.
 *
 * ISOLATION, AND WHAT IT IS NOT.
 *   - The working directory is an empty temp directory, so no CLAUDE.md, no
 *     project settings and no repository are discovered.
 *   - CLAUDE_CONFIG_DIR points at a fresh temp directory, so the founder's own
 *     memory, history and MCP servers are not read.
 *   - `--strict-mcp-config` means the ONLY MCP server is the one this run
 *     wrote, and `--setting-sources ''` means no user/project/local settings.
 *   - `--allowedTools mcp__openswitchboard__*` with
 *     `--permission-mode bypassPermissions` so a headless turn never stops on a
 *     prompt, and `--disallowedTools AskUserQuestion` so the assistant asks its
 *     question in PLAIN TEXT where the simulated human can answer it. A
 *     structured question tool in a headless run is a deadlock: the harness
 *     never sees the options and the turn never ends.
 *
 * WHAT IS NOT ISOLATED, SAID PLAINLY: authentication. The CLI signs in as
 * whoever this machine is signed in as, and a managed/policy settings file
 * still applies (`--setting-sources` does not reach it). Turns are billed to
 * that account. There is no way around that from here and the README says so.
 *
 * THE MCP CONFIG HOLDS AN AGENT KEY. It is written 0600 into the run's own
 * private directory, it is deleted at teardown, and it is never logged.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentReply, Driver } from '../types.js';

export interface ClaudeArgsInput {
  utterance: string;
  mcpConfigPath: string;
  /** Present on every turn after the first: the id the first turn printed. */
  resumeSessionId?: string;
}

/**
 * The argv, built as a pure function so it can be tested without a CLI.
 *
 * Every flag here was read off `claude --help` on 2026-09-19 rather than
 * remembered. If one of them moves, this is the one place to change and the one
 * place a unit test will notice.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    '--print',
    '--output-format',
    'json',
    '--mcp-config',
    input.mcpConfigPath,
    '--strict-mcp-config',
    // Comma-separated rather than space-separated: a space-separated list after
    // a variadic option swallows the next flag.
    '--allowedTools',
    'mcp__openswitchboard__*',
    '--disallowedTools',
    'AskUserQuestion',
    '--permission-mode',
    'bypassPermissions',
    // Nothing of this machine's own configuration.
    '--setting-sources',
    '',
  ];
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  // The prompt is the positional argument, and it goes LAST so nothing in the
  // human's words can be read as a flag.
  args.push('--', input.utterance);
  return args;
}

/** Pull the words and the session id out of `--output-format json`. */
export function readClaudeJson(stdout: string): {
  text: string;
  sessionId?: string;
  toolActivity?: string[];
} {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`no JSON from claude: ${stdout.slice(0, 300)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (e) {
    throw new Error(`unparseable claude JSON: ${(e as Error).message}`);
  }
  if (parsed?.is_error) {
    throw new Error(`claude returned an error: ${String(parsed?.result ?? '').slice(0, 300)}`);
  }
  const text = String(parsed?.result ?? '').trim();
  const sessionId = parsed?.session_id ? String(parsed.session_id) : undefined;
  // The json envelope carries a result and a usage summary rather than the
  // message list, so tool names are only visible when it happens to carry them.
  // Absent rather than empty when it does not: "cannot see" and "called
  // nothing" are different findings.
  const names = collectToolNames(parsed);
  return { text, sessionId, ...(names ? { toolActivity: names } : {}) };
}

function collectToolNames(parsed: any): string[] | undefined {
  const out: string[] = [];
  let sawAny = false;
  const walk = (v: any, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v.type === 'tool_use' && typeof v.name === 'string') {
      sawAny = true;
      out.push(v.name);
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(parsed?.messages ?? parsed?.content ?? null, 0);
  return sawAny ? out : undefined;
}

export interface ClaudeDriverOptions {
  /** Where the 0600 mcp config and the throwaway config dir are written. */
  privateDir: string;
  mcpUrl?: string;
  timeoutMs?: number;
  /** For tests. Defaults to really spawning `claude`. */
  spawn?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;
}

function realSpawn(timeoutMs: number) {
  return (args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'claude',
        args,
        { env, cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && !stdout) return reject(new Error(`claude failed: ${err.message}\n${stderr}`));
          resolve(stdout);
        },
      );
    });
}

/**
 * One Claude Code assistant, held to the same contract as the OpenClaw two.
 *
 * Sessions: the CLI mints an id on the first turn and prints it in the JSON;
 * every later turn on the same track passes it back with `--resume`. The
 * harness's own session id is the key of a map rather than something passed to
 * the CLI, because `--session-id` wants a uuid and the harness's ids are words.
 */
export function claudeCodeDriver(opts: ClaudeDriverOptions): Driver {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const spawn = opts.spawn ?? realSpawn(timeoutMs);
  const sessions = new Map<string, string>();
  let mcpConfigPath = '';
  let configDir = '';
  let workDir = '';

  return {
    name: 'Claude',

    async prepare(agentKey: string, runId: string): Promise<string> {
      // A fresh everything, per run. Nothing survives from the last one, which
      // is the whole of what "deep clean" means for this client.
      mkdirSync(opts.privateDir, { recursive: true, mode: 0o700 });
      configDir = mkdtempSync(join(opts.privateDir, `cc-config-${runId}-`));
      workDir = mkdtempSync(join(opts.privateDir, `cc-cwd-${runId}-`));
      mcpConfigPath = join(configDir, 'mcp.json');
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            openswitchboard: {
              type: 'http',
              url: `${(opts.mcpUrl ?? 'https://mcp-dev.openswitchboard.ai').replace(/\/$/, '')}/mcp`,
              headers: { Authorization: `Bearer ${agentKey}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      sessions.clear();
      // The path, never the contents.
      return 'Claude: fresh config dir and empty working directory; one MCP server, written 0600';
    },

    async ask(sessionId: string, utterance: string): Promise<AgentReply> {
      if (!mcpConfigPath) throw new Error('claudeCodeDriver.prepare was never called');
      const args = buildClaudeArgs({
        utterance,
        mcpConfigPath,
        resumeSessionId: sessions.get(sessionId),
      });
      const stdout = await spawn(
        args,
        { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_SIMPLE: '1' },
        workDir,
      );
      const read = readClaudeJson(stdout);
      if (read.sessionId) sessions.set(sessionId, read.sessionId);
      if (!read.text) {
        throw new Error('claude produced no text (provider failure or an empty turn)');
      }
      return { text: read.text, toolActivity: read.toolActivity, model: 'claude-code' };
    },

    async teardown(): Promise<void> {
      // The key on disk goes with the run that minted it.
      for (const dir of [configDir, workDir]) {
        if (!dir) continue;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* teardown never fails a run */
        }
      }
      mcpConfigPath = '';
    },
  };
}
