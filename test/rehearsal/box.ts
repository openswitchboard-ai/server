/**
 * THE DEEP CLEAN, AND WHY THE OLD RESETS WERE NOT ENOUGH.
 *
 * test/adversary/box.ts and test/duet/agentB.ts both "wipe" an assistant, and
 * both miss things that outlive a run and change what the next one measures:
 *
 *   workspace/memory/.dreams   a hidden corpus the agent writes to itself
 *   the state database's memory rows, which survive a sessions wipe
 *   cron jobs the agent made for itself ("check the switchboard every hour")
 *   workspace/skills/switchboard-*, skills it WROTE ABOUT THE SWITCHBOARD
 *                                   after reading the manual once
 *
 * An assistant carrying a self-written switchboard skill into run 4 is not the
 * assistant run 1 measured, and the fourth run's clean score is the skill's,
 * not the manual's. `~/osb-deep-clean.sh <dir> <unit>` on the box clears all of
 * it and keeps the Telegram pairing (which is configuration, not recollection).
 * This module runs it, then hands over the run's key and starts the unit again.
 *
 * THE KEY GOES OVER STDIN. Never on a command line — a command line is visible
 * in `ps` to anything else on the box and lands in shell history — and never in
 * a log line. `read -r H` on the far side, `input:` on this one.
 */
import { execFile, execFileSync } from 'node:child_process';
import { AGENT_HOMES, DEEP_CLEAN } from './config.js';

export type AgentName = keyof typeof AGENT_HOMES;

function sshArgs(host: string, key: string): string[] {
  return ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20', '-i', key, host];
}

export function ssh(host: string, key: string, script: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [...sshArgs(host, key), script],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`ssh failed: ${err.message}\n${stderr}`));
        resolve(`${stdout}${stderr}`);
      },
    );
  });
}

/**
 * Stop the unit, forget everything, hand over `agentKey`, start the unit again,
 * and prove the key reaches the switchboard.
 *
 * Returns one line fit for a log. It carries the unit's state and the probe's
 * HTTP status and NOTHING of the key.
 */
export async function deepCleanAndBind(
  agent: AgentName,
  host: string,
  key: string,
  agentKey: string,
  mcpUrl: string,
): Promise<string> {
  const home = AGENT_HOMES[agent];
  const cleaned = (await ssh(host, key, `${DEEP_CLEAN} ${home.dir} ${home.unit}`, 300_000))
    .trim()
    .split('\n')
    .slice(-1)[0];

  // The key over stdin, exactly as scratchpad/dev-reset2.mts does it: the far
  // side reads one line into $H and hands it to `config set`, so the token is
  // never an argv element anywhere.
  const remote = [
    'export PATH=$PATH:~/.local/bin:/usr/local/bin',
    'read -r H',
    `openclaw ${home.profile} --log-level silent config set mcp.servers.openswitchboard.headers.Authorization "$H" >/dev/null`,
    `systemctl --user start ${home.unit}`,
    `for i in $(seq 1 25); do [ "$(systemctl --user is-active ${home.unit})" = active ] && break; sleep 3; done`,
    `systemctl --user is-active ${home.unit}`,
  ].join('; ');
  const active = execFileSync('ssh', [...sshArgs(host, key), remote], {
    input: `Bearer ${agentKey}\n`,
    encoding: 'utf8',
    timeout: 240_000,
    // stderr is dropped rather than captured: systemd is chatty and nothing it
    // says here is worth the risk of echoing a line that quoted the header.
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();

  const probe = await fetch(`${mcpUrl.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${agentKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

  return `${agent}: deep-clean ${cleaned || 'done'}, gateway ${active}, key probe HTTP ${probe.status}`;
}
