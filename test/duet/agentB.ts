/**
 * Driver for the SECOND real agent — "Marlowe's assistant" (agent B) — on the
 * same EC2 box as Nagatha, in a completely separate OpenClaw home.
 *
 * ISOLATION. OpenClaw's own `--profile <name>` flag moves the config path and
 * the state directory to `~/.openclaw-<name>`, so `--profile marlowe` gives B
 * its own openclaw.json, its own state database, its own agent sessions, its
 * own workspace (AGENTS.md / SOUL.md / USER.md / memory) and its own MCP
 * server list — including its own OpenSwitchboard agent key, which is what
 * makes it a genuinely separate person's assistant rather than a second voice
 * on Nagatha's account. Nothing in ~/.openclaw is read or written here.
 *
 * NO SECOND GATEWAY. B is driven with `agent --local`, the embedded runner: the
 * process lives only for the turn and exits. The box has 3.8 GB of RAM and
 * Nagatha's gateway is already capped at a 1376 MB heap; a second long-lived
 * gateway would have been the first thing to die under memory pressure, and it
 * buys nothing here — sessions persist across `--local` invocations (they live
 * in B's own agent SQLite, keyed by --session-id) exactly as they do through a
 * gateway, which is the only property the duet needs. A port (18790) is
 * configured for B all the same, so a gateway CAN be started for it later
 * without touching anything else.
 *
 * THE CONTRACT is deliberately identical to nagatha.ts: one human utterance in,
 * her verbatim reply out, same session id across a track. Two differences the
 * envelope forces:
 *   - `--local` prints the payloads at the TOP level ({payloads, meta}), where
 *     the gateway path nests them under `result`. Both shapes are accepted.
 *   - `--local` carries no `ok`/`status` field, so a failed provider call shows
 *     up as an empty payload list rather than an error envelope; that is
 *     surfaced as the mechanical failure it is, never graded as a bad reply.
 */
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';

export const B_HOST = process.env.DUET_B_HOST ?? 'ubuntu@16.176.240.234';
export const B_KEY = process.env.DUET_B_KEY ?? `${process.env.HOME}/.ssh/openclaw-test.pem`;
/** The OpenClaw profile name; its home is ~/.openclaw-<profile>. */
export const B_PROFILE = process.env.DUET_B_PROFILE ?? 'marlowe';
export const B_HOME = `/home/ubuntu/.openclaw-${B_PROFILE}`;
const REMOTE_PATH = 'export PATH=$PATH:~/.local/bin:/usr/local/bin';
const AGENT_TIMEOUT_S = Number(process.env.DUET_B_TIMEOUT_S ?? 300);

export interface AgentReply {
  /** Verbatim words (all payload texts joined). */
  text: string;
  model: string;
  durationMs?: number;
  /** Tool names the turn actually called — B's own record of what it did. */
  toolsUsed: string[];
  /** Raw JSON string, kept for the report's audit trail. */
  raw: string;
}

function ssh(remoteScript: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'ConnectTimeout=20',
        '-i',
        B_KEY,
        B_HOST,
        remoteScript,
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`ssh failed: ${err.message}\n${stderr}`));
        resolve(stdout);
      },
    );
  });
}

/**
 * Pull the JSON object out of stdout. `--log-level silent` normally leaves
 * nothing but the object, but a provider transport line can still slip in
 * ahead of it, so every `{` is tried in turn from the first.
 */
function extractJson(stdout: string): any {
  for (let i = stdout.indexOf('{'); i >= 0; i = stdout.indexOf('{', i + 1)) {
    try {
      return JSON.parse(stdout.slice(i));
    } catch {
      /* not the start of the object — try the next brace */
    }
  }
  throw new Error(`no JSON from openclaw: ${stdout.slice(0, 400)}`);
}

/** Send one human utterance to agent B on `sessionId`; capture its reply. */
export async function ask(sessionId: string, utterance: string): Promise<AgentReply> {
  const b64 = Buffer.from(utterance, 'utf8').toString('base64');
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  const remote = [
    REMOTE_PATH,
    'f=$(mktemp)',
    `printf %s '${b64}' | base64 -d > "$f"`,
    `openclaw --log-level silent --profile ${B_PROFILE} agent --local --json ` +
      `--timeout ${AGENT_TIMEOUT_S} --session-id '${sid}' --message-file "$f"`,
    'rc=$?',
    'rm -f "$f"',
    'exit $rc',
  ].join('; ');

  const stdout = await ssh(remote, (AGENT_TIMEOUT_S + 60) * 1000);
  const parsed = extractJson(stdout);
  if (parsed?.ok === false || parsed?.error) {
    const msg = parsed?.error?.message ?? 'openclaw returned ok:false with no error message';
    throw new Error(`agent B call failed: ${String(msg).slice(0, 300)}`);
  }
  // --local puts payloads at the top level; the gateway path nests them.
  const body = parsed?.payloads ? parsed : (parsed?.result ?? {});
  const payloads: any[] = body?.payloads ?? [];
  const text = payloads
    .map((p) => p?.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  const meta = body?.meta?.agentMeta ?? {};
  if (!text) {
    // No words at all means the model call did not land (quota, transport).
    // Graded as an empty reply it would look like a register failure B never
    // committed, so it is raised as the mechanical error it is.
    throw new Error(
      `agent B produced no text (provider failure?): ${JSON.stringify(parsed).slice(0, 400)}`,
    );
  }
  return {
    text,
    model: meta.model ?? 'unknown',
    durationMs: body?.meta?.durationMs,
    toolsUsed: meta?.terminalReceipt?.successfulToolNames ?? [],
    raw: JSON.stringify(parsed),
  };
}

/** The model B is configured to use, for the report tag. */
export async function readModel(): Promise<string> {
  const out = await ssh(
    `${REMOTE_PATH}; openclaw --log-level silent --profile ${B_PROFILE} config get agents.defaults.model`,
    30_000,
  );
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')));
    return j.primary ?? j.model ?? out.trim();
  } catch {
    return out.trim();
  }
}

/**
 * Wipe B back to a clean agent: sessions, its per-agent database, its state
 * database and its workspace memory. Nothing persistent is started or stopped
 * — B has no gateway — so this is just the file removal. Its identity files
 * (AGENTS.md / SOUL.md / USER.md / IDENTITY.md) are deliberately left alone;
 * they are its configuration, not its recollection of a previous run.
 */
export async function resetB(): Promise<string> {
  const remote = [
    REMOTE_PATH,
    `rm -rf ${B_HOME}/agents/main/sessions/* ${B_HOME}/agents/main/agent/openclaw-agent.sqlite*`,
    `rm -rf ${B_HOME}/state/openclaw.sqlite* ${B_HOME}/workspace/memory/* ${B_HOME}/workspace/MEMORY.md`,
    `mkdir -p ${B_HOME}/workspace/memory`,
    `echo "agent B reset: $(date -Is)"`,
  ].join('; ');
  return (await ssh(remote, 60_000)).trim();
}

/**
 * Swap the OpenSwitchboard agent key B presents, and read back what actually
 * stuck. The read-back goes to the file rather than `config get`, which redacts
 * anything it takes for a secret and would report success either way.
 */
export async function setAgentKey(key: string): Promise<string> {
  const remote = [
    REMOTE_PATH,
    `openclaw --log-level silent --profile ${B_PROFILE} config set ` +
      `mcp.servers.openswitchboard.headers.Authorization "Bearer ${key}" > /dev/null`,
    `python3 -c "import json;print(json.load(open('${B_HOME}/openclaw.json'))['mcp']['servers']['openswitchboard']['headers']['Authorization'])"`,
  ].join('; ');
  const got = (await ssh(remote, 60_000)).trim();
  if (got !== `Bearer ${key}`) {
    throw new Error(`agent B's key did not stick (config now holds "${got.slice(0, 30)}…")`);
  }
  return got;
}
