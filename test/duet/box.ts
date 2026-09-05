/**
 * The Nagatha-side box operations the duet needs on top of test/adversary/box.ts:
 * pointing her at the run's own Priya account for the length of the run, putting
 * her back afterwards, and parking the distilled memory file that a reset does
 * not touch.
 *
 * WHY THE KEY SWAP. Two of the steps this eval exists to exercise — the stage-3
 * opt-in and accepting an offer — happen on the HUMAN's approval page, behind an
 * email-code sign-in. Nagatha's long-lived dev account is not one this harness
 * can sign in to (the address is encrypted at rest and recorded nowhere), which
 * is exactly why the realism eval had to stop at stage 2. So for the run she is
 * pointed at a fresh account the harness provisioned and can therefore act as
 * the human for. Her original key is read first and restored at teardown; her
 * old account is not touched, read or written by any of this.
 *
 * WHY MEMORY.md IS PARKED. box.ts's reset wipes sessions, everything under
 * `workspace/memory`, and the state database — the raw layer. It does NOT touch
 * `MEMORY.md`, the distilled layer at the workspace root, and on this box that
 * file is thick with the adversary eval's residue: a stale bike listing on the
 * old account, and a standing prior that every counterparty called Robin-
 * something, in Fremantle, is a scammer. Running a fresh two-agent negotiation
 * against that is measuring a primed agent, which
 * is the exact failure box.ts's own docstring warns about. So the file is moved
 * aside for the run and moved back at teardown, and the run reports that it did.
 * USER.md is deliberately LEFT IN PLACE: it holds who Priya is, which is
 * persona, not recollection of a previous eval.
 */
import { execFile } from 'node:child_process';
import { NAGATHA_HOST, NAGATHA_KEY } from '../realism/nagatha.js';

const REMOTE_PATH = 'export PATH=$PATH:~/.local/bin:/usr/local/bin';
const HOME = '/home/ubuntu/.openclaw';

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

/**
 * The Authorization header Nagatha's MCP client currently presents.
 *
 * Read straight out of openclaw.json rather than through `openclaw config get`:
 * the CLI redacts anything it considers a secret, and it considers this one —
 * it hands back the literal string `__OPENCLAW_REDACTED__`. Saving THAT as the
 * value to restore at teardown would have quietly left her pointed at a
 * placeholder instead of her own key.
 */
export async function readNagathaAuthHeader(): Promise<string> {
  const out = await ssh(
    `python3 -c "import json;print(json.load(open('${HOME}/openclaw.json'))['mcp']['servers']['openswitchboard']['headers']['Authorization'])"`,
    30_000,
  );
  const header = out.trim();
  if (!header || header.includes('REDACTED') || !/^Bearer\s+\S+/.test(header)) {
    throw new Error(`refusing to run: could not read Nagatha's real MCP header (got "${header}")`);
  }
  return header;
}

/** Point her MCP client at `header` (a full "Bearer osb_ak_…" string) and
 *  restart the gateway so the new key is the one that connects. */
export async function setNagathaAuthHeader(header: string): Promise<string> {
  const remote = [
    REMOTE_PATH,
    `openclaw --log-level silent config set mcp.servers.openswitchboard.headers.Authorization ${JSON.stringify(header)}`,
    'systemctl --user restart openclaw-gateway',
    'sleep 8',
    'systemctl --user is-active openclaw-gateway',
  ].join('; ');
  return (await ssh(remote, 120_000)).trim();
}

/** Move MEMORY.md aside (idempotent: a park with one already parked is a no-op). */
export async function parkNagathaMemory(): Promise<string> {
  const remote = [
    `if [ -f ${HOME}/workspace/MEMORY.md ] && [ ! -f ${HOME}/workspace/MEMORY.md.duet-parked ]; then`,
    `  mv ${HOME}/workspace/MEMORY.md ${HOME}/workspace/MEMORY.md.duet-parked; echo parked;`,
    `else echo "nothing to park"; fi`,
  ].join(' ');
  return (await ssh(remote, 30_000)).trim();
}

/** Put MEMORY.md back exactly as it was, discarding anything the run wrote. */
export async function unparkNagathaMemory(): Promise<string> {
  const remote = [
    `if [ -f ${HOME}/workspace/MEMORY.md.duet-parked ]; then`,
    `  mv -f ${HOME}/workspace/MEMORY.md.duet-parked ${HOME}/workspace/MEMORY.md; echo restored;`,
    `else echo "nothing parked"; fi`,
  ].join(' ');
  return (await ssh(remote, 30_000)).trim();
}

/** What Nagatha wrote into MEMORY.md during the run, before it is discarded. */
export async function readNagathaRunMemory(): Promise<string> {
  return (await ssh(`cat ${HOME}/workspace/MEMORY.md 2>/dev/null | head -c 8000`, 30_000)).trim();
}
