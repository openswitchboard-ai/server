/**
 * One utterance to an OpenClaw assistant THROUGH ITS RUNNING GATEWAY, for any
 * profile on the box.
 *
 * test/realism/nagatha.ts does exactly this for the default profile and
 * test/duet/agentB.ts drives a second profile with `agent --local`, the
 * embedded runner. The rehearsal suite needs neither as they stand for Bilby:
 * his gateway is up (that is what lets him wake himself, schedule a look and
 * reach his human, which stage 1 asks of him), and `--local` refuses to run
 * beside a live gateway on the same state directory. So this is nagatha.ts's
 * path with the profile as a parameter, and nothing else changed.
 */
import { execFile } from 'node:child_process';

const REMOTE_PATH = 'export PATH=$PATH:~/.local/bin:/usr/local/bin';
const AGENT_TIMEOUT_S = Number(process.env.REHEARSAL_AGENT_TIMEOUT_S ?? 300);

export interface GatewayReply {
  text: string;
  model: string;
  durationMs?: number;
  toolsUsed: string[];
  toolsObserved: boolean;
  raw: string;
}

function ssh(host: string, key: string, remoteScript: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20', '-i', key, host, remoteScript],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`ssh failed: ${err.message}\n${stderr}`));
        resolve(stdout);
      },
    );
  });
}

/** `profile` is '' for the default home or a bare profile name such as 'bilby'. */
export async function askThroughGateway(
  host: string,
  key: string,
  profile: string,
  sessionId: string,
  utterance: string,
): Promise<GatewayReply> {
  if (profile && !/^[a-z][a-z0-9-]{0,30}$/.test(profile)) throw new Error('bad profile name');
  const b64 = Buffer.from(utterance, 'utf8').toString('base64');
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  const flag = profile ? `--profile ${profile} ` : '';
  const remote = [
    REMOTE_PATH,
    'f=$(mktemp)',
    `printf %s '${b64}' | base64 -d > "$f"`,
    `openclaw ${flag}agent --json --timeout ${AGENT_TIMEOUT_S} --session-id '${sid}' --message-file "$f"`,
    'rc=$?',
    'rm -f "$f"',
    'exit $rc',
  ].join('; ');
  const stdout = await ssh(host, key, remote, (AGENT_TIMEOUT_S + 60) * 1000);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) throw new Error(`no JSON from openclaw: ${stdout.slice(0, 400)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (e) {
    throw new Error(`unparseable openclaw JSON: ${(e as Error).message}\n${stdout.slice(0, 600)}`);
  }
  if (parsed?.ok === false || parsed?.error) {
    const msg = parsed?.error?.message ?? 'openclaw returned ok:false with no error message';
    throw new Error(`openclaw agent call failed: ${String(msg).slice(0, 300)}`);
  }
  const payloads: any[] = parsed?.result?.payloads ?? parsed?.payloads ?? [];
  // AN ATTACHMENT IS PART OF WHAT WAS SAID. OpenClaw hands a picture back as
  // `mediaUrl` beside the text, and this kept the text alone — so when an
  // assistant passed on a photo the way a person would, by putting the picture
  // in front of its human, the transcript read "here it is, straight from
  // him:" followed by nothing, the simulated human asked "what is it?", and
  // the suite failed the assistant for a picture it had in fact delivered
  // (23 September 2026; the gateway's own log shows the attachment). Written
  // the way the gateway itself renders it, one line each.
  const text = payloads
    .flatMap((p) => {
      const media = [p?.mediaUrl, ...(Array.isArray(p?.mediaUrls) ? p.mediaUrls : [])].filter(
        (u): u is string => typeof u === 'string' && u.length > 0,
      );
      return [p?.text ?? '', ...media.map((u) => `Attachment: ${u}`)];
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  const meta = parsed?.result?.meta?.agentMeta ?? parsed?.meta?.agentMeta ?? {};
  const receipt = meta?.terminalReceipt?.successfulToolNames;
  return {
    text,
    model: meta.model ?? 'unknown',
    durationMs: parsed?.result?.meta?.durationMs,
    toolsUsed: Array.isArray(receipt) ? receipt.map((t: unknown) => String(t)) : [],
    toolsObserved: Array.isArray(receipt),
    raw: stdout.slice(jsonStart),
  };
}
