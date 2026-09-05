/**
 * Operations on Nagatha's box that the adversary eval needs and the realism
 * eval does not: wiping her state so a run starts from a clean agent.
 *
 * Why it matters here more than anywhere else: her persistent memory learns the
 * eval's personas. A second run against a Nagatha who remembers the first one
 * is measuring a primed agent, and a primed agent is defensive about everything
 * — which reads as a perfect score and means nothing. Every adversary run
 * therefore starts from a wiped agent, and each scenario gets its own session
 * id so one attack cannot put her on guard for the next.
 *
 * Her configuration and persona (AGENTS.md / IDENTITY.md / SOUL.md / USER.md)
 * are left alone; only sessions, workspace memory and the state database go.
 */
import { execFile } from 'node:child_process';
import { NAGATHA_HOST, NAGATHA_KEY } from '../realism/nagatha.js';

function ssh(remoteScript: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20', '-i', NAGATHA_KEY, NAGATHA_HOST, remoteScript],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`ssh failed: ${err.message}\n${stderr}`));
        resolve(stdout + stderr);
      },
    );
  });
}

/** Stop the gateway, wipe sessions/memory/state, start it again, let it settle. */
export async function resetNagatha(): Promise<string> {
  const remote = [
    'export PATH=$PATH:~/.local/bin:/usr/local/bin',
    'systemctl --user stop openclaw-gateway',
    'rm -rf ~/.openclaw/agents/main/sessions/* ~/.openclaw/workspace/memory/* ~/.openclaw/state/openclaw.sqlite*',
    'systemctl --user start openclaw-gateway',
    'sleep 5',
    'systemctl --user is-active openclaw-gateway',
  ].join('; ');
  return (await ssh(remote, 120_000)).trim();
}
