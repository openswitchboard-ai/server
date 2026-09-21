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

/**
 * A directory holding nothing but this rig's own Claude Code login, signed in
 * once by hand:
 *
 *   mkdir -p ~/.osb-rehearsal-claude
 *   CLAUDE_CONFIG_DIR=~/.osb-rehearsal-claude claude   # then /login
 *   export REHEARSAL_CLAUDE_CONFIG_DIR=~/.osb-rehearsal-claude
 *
 * Unset, the driver makes a fresh directory per run as it always did — which
 * is properly isolated and, on a machine whose login lives in the Keychain,
 * not signed in to anything.
 */
const REHEARSAL_CLAUDE_CONFIG_DIR = process.env.REHEARSAL_CLAUDE_CONFIG_DIR ?? '';

/**
 * WHICH MODEL THE THIRD ASSISTANT IS, SAID OUT LOUD.
 *
 * Passing no --model takes the signed-in account's default, which on 20
 * September 2026 was Opus 5 — so the rig was quietly testing the manual
 * against the strongest model available while recording only "claude-code",
 * and a change to that account's default would have changed the test with
 * nothing in any transcript to say so.
 *
 * Sonnet is the default here for two reasons. It is the honest test: the
 * manual-delivery problems this suite exists to find are the ones a smaller
 * model hits first, and most people will not arrive on the largest model. And
 * it costs a fraction of Opus, which matters when a series runs six times.
 */
const REHEARSAL_CLAUDE_MODEL =
  process.env.REHEARSAL_CLAUDE_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * THE THIRD ASSISTANT SIGNS IN THROUGH BEDROCK, ON THE AWS CREDENTIALS THE
 * RUN ALREADY HOLDS.
 *
 * The driver runs the CLI in bare mode (CLAUDE_CODE_SIMPLE), and bare mode
 * never reads OAuth or the keychain: authentication there is an API key or a
 * third-party provider, nothing else. A whole afternoon of 20 September 2026
 * went on "Not logged in · Please run /login" answers from a CLI that was
 * signed in perfectly well — it simply was not allowed to look.
 *
 * Bedrock settles it without a new credential of any kind: the rehearsal
 * already runs under AWS_PROFILE to reach the database and the logs, and
 * Bedrock takes the same ones. Haiku 4.5 costs about two tenths of a cent a
 * turn, so a six-run series is small change, and it is the honest test as
 * well as the cheap one — the manual-delivery faults this suite exists to
 * find are the ones a smaller model hits first.
 *
 * Set REHEARSAL_CLAUDE_BEDROCK=0 to go back to a plain ANTHROPIC_API_KEY.
 */
const USE_BEDROCK = (process.env.REHEARSAL_CLAUDE_BEDROCK ?? '1') !== '0';

export interface ClaudeArgsInput {
  utterance: string;
  mcpConfigPath: string;
  /**
   * Named on every call, never defaulted, so a transcript from today stays
   * comparable with one from next month. This was passed and read for days
   * before it was declared here: tsx strips types without checking them, so
   * the rehearsal tsconfig went on compiling nothing while it was red.
   */
  model: string;
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
    // Named rather than defaulted, so a transcript from today stays
    // comparable with one from next month.
    '--model',
    input.model,
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
      // THE CONFIG DIR IS WHERE THE LOGIN LIVES, so a fresh one per run means
      // no login at all: on macOS the token sits in the Keychain but the
      // account record does not, and the CLI answers "Not logged in · Please
      // run /login". Half the runs of 20 September 2026 died there.
      //
      // So a dedicated directory can be named instead, logged into ONCE by
      // hand and reused. It is not the founder's own ~/.claude: it holds
      // nothing but this rig's login, so the isolation that matters is intact
      // — the working directory is still empty, --strict-mcp-config still
      // means the only MCP server is the one written below, and
      // --setting-sources '' still means no project or user settings.
      configDir = REHEARSAL_CLAUDE_CONFIG_DIR || mkdtempSync(join(opts.privateDir, `cc-config-${runId}-`));
      if (REHEARSAL_CLAUDE_CONFIG_DIR) mkdirSync(configDir, { recursive: true, mode: 0o700 });
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
      return REHEARSAL_CLAUDE_CONFIG_DIR
        ? 'Claude: the rig\u2019s own signed-in config dir and an empty working directory; one MCP server, written 0600'
        : 'Claude: fresh config dir and empty working directory; one MCP server, written 0600';
    },

    async ask(sessionId: string, utterance: string): Promise<AgentReply> {
      if (!mcpConfigPath) throw new Error('claudeCodeDriver.prepare was never called');
      const args = buildClaudeArgs({
        utterance,
        mcpConfigPath,
        model: REHEARSAL_CLAUDE_MODEL,
        resumeSessionId: sessions.get(sessionId),
      });
      const stdout = await spawn(
        args,
        {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_SIMPLE: '1',
          ...(USE_BEDROCK ? { CLAUDE_CODE_USE_BEDROCK: '1' } : {}),
        },
        workDir,
      );
      const read = readClaudeJson(stdout);
      if (read.sessionId) sessions.set(sessionId, read.sessionId);
      if (!read.text) {
        throw new Error('claude produced no text (provider failure or an empty turn)');
      }
      // The model by name: "claude-code" told a reader nothing about what was
      // actually on the other end of the conversation.
      return { text: read.text, toolActivity: read.toolActivity, model: REHEARSAL_CLAUDE_MODEL };
    },

    async teardown(): Promise<void> {
      // THE KEY ON DISK GOES WITH THE RUN THAT MINTED IT — but a config dir
      // the rig was signed into by hand is not ours to delete, or the next run
      // is back to "Not logged in". Where one was named, only the MCP file
      // this run wrote is removed; the throwaway dirs go whole.
      if (mcpConfigPath && REHEARSAL_CLAUDE_CONFIG_DIR) {
        try {
          rmSync(mcpConfigPath, { force: true });
        } catch {
          /* teardown never fails a run */
        }
      }
      const doomed = REHEARSAL_CLAUDE_CONFIG_DIR ? [workDir] : [configDir, workDir];
      for (const dir of doomed) {
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
