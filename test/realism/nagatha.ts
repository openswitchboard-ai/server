/**
 * Driver for the REAL agent under test — "Nagatha", an OpenClaw agent on the
 * EC2 box. We drive her one human-utterance at a time and capture her verbatim
 * reply. Every turn in a track shares one --session-id so her conversation
 * builds naturally (needed for recall scenarios); different tracks use
 * different session ids so an email-prompted cold-open really starts cold.
 *
 * The utterance is shipped base64-encoded into a temp file on the box and read
 * back with --message-file, so nothing in the human's words can break remote
 * shell quoting. Her reply is read from `openclaw agent --json`
 * (result.payloads[].text), and the model actually used is read back from the
 * same JSON (meta.agentMeta.model) so the report is tagged with what ran.
 */
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';

export const NAGATHA_HOST = process.env.NAGATHA_HOST ?? 'ubuntu@16.176.240.234';
export const NAGATHA_KEY = process.env.NAGATHA_KEY ?? `${process.env.HOME}/.ssh/openclaw-test.pem`;
const REMOTE_PATH = 'export PATH=$PATH:~/.local/bin:/usr/local/bin';
const AGENT_TIMEOUT_S = Number(process.env.NAGATHA_TIMEOUT_S ?? 240);

export interface NagathaReply {
  /** Her verbatim words (all payload texts joined). */
  text: string;
  model: string;
  runId?: string;
  durationMs?: number;
  status: string;
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
        NAGATHA_KEY,
        NAGATHA_HOST,
        remoteScript,
      ],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`ssh failed: ${err.message}\n${stderr}`));
        resolve(stdout);
      },
    );
  });
}

/** Send one human utterance to Nagatha on `sessionId`; capture her reply. */
export async function ask(sessionId: string, utterance: string): Promise<NagathaReply> {
  const b64 = Buffer.from(utterance, 'utf8').toString('base64');
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  const remote = [
    REMOTE_PATH,
    'f=$(mktemp)',
    `printf %s '${b64}' | base64 -d > "$f"`,
    `openclaw agent --json --timeout ${AGENT_TIMEOUT_S} --session-id '${sid}' --message-file "$f"`,
    'rc=$?',
    'rm -f "$f"',
    'exit $rc',
  ].join('; ');

  const stdout = await ssh(remote, (AGENT_TIMEOUT_S + 60) * 1000);
  // The JSON object is the whole stdout; guard against any stray prefix lines.
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) throw new Error(`no JSON from openclaw: ${stdout.slice(0, 400)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (e) {
    throw new Error(`unparseable openclaw JSON: ${(e as Error).message}\n${stdout.slice(0, 600)}`);
  }
  // A failed model call (rate limit, provider outage) comes back ok:false with
  // no payloads. Left alone it grades as an empty reply — a register failure
  // she never committed — so surface it as the mechanical error it is.
  if (parsed?.ok === false || parsed?.error) {
    const msg = parsed?.error?.message ?? 'openclaw returned ok:false with no error message';
    throw new Error(`openclaw agent call failed: ${String(msg).slice(0, 300)}`);
  }
  const payloads: any[] = parsed?.result?.payloads ?? [];
  const text = payloads
    .map((p) => p?.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  const meta = parsed?.result?.meta?.agentMeta ?? {};
  return {
    text,
    model: meta.model ?? 'unknown',
    runId: parsed?.runId,
    durationMs: parsed?.result?.meta?.durationMs,
    status: parsed?.status ?? 'unknown',
    raw: stdout.slice(jsonStart),
  };
}

/** Read the model OpenClaw is configured to use, for the report tag. */
export async function readModel(): Promise<string> {
  const remote = `${REMOTE_PATH}; openclaw config get agents.defaults.model`;
  const out = await ssh(remote, 30_000);
  try {
    const j = JSON.parse(out);
    return j.primary ?? j.model ?? out.trim();
  } catch {
    return out.trim();
  }
}
