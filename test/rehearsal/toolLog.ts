/**
 * THE NAME-ONLY TOOL-CALL LOG, AND WHAT IT CAN AND CANNOT ANSWER.
 *
 * src/mcp/mcp.ts writes one line per tool call: `{"msg":"tool call","tool":…,
 * "section":…}` and NOTHING ELSE — no account, no session, no arguments. That
 * is deliberate (mcp.ts says so where it writes it) and it is the reason
 * "did THIS assistant read the manual" is often unanswerable: two assistants
 * are driven in one window and their lines are indistinguishable.
 *
 * So this module reads the window and hands back the lines, and the check
 * (checks.ts, checkManual) is careful to record "unknown" rather than fail an
 * assistant on an observability gap. Where the harness CAN separate them — one
 * side driven alone, with a quiet gap either side — the lines are attributed by
 * time and the check says it did that.
 *
 * READ WITH THE AWS CLI. @aws-sdk/client-cloudwatch-logs is not a dependency of
 * this repository and this suite is not a reason to add one; `aws logs
 * filter-log-events` is already how an operator reads this group. A machine
 * without the CLI gets an empty list and a check that says so.
 */
import { execFile } from 'node:child_process';
import { REGION, TOOL_LOG_GROUP } from './config.js';
import type { ToolCallLine } from './checks.js';

function run(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('aws', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`aws logs failed: ${err.message}\n${stderr}`));
      resolve(stdout);
    });
  });
}

export interface ToolLogWindow {
  lines: ToolCallLine[];
  /** Absent when the lines were read; a sentence when they could not be. */
  unavailable?: string;
}

/**
 * Every tool-call line between two instants.
 *
 * `windows` lets the caller say which slice of time belonged to which side, for
 * the cases where the run really did drive one assistant alone. A line outside
 * every window keeps `side` undefined, which is what makes the manual check
 * report "unknown" instead of guessing.
 */
export async function readToolCalls(
  fromMs: number,
  toMs: number,
  windows: { side: 'seller' | 'buyer'; fromMs: number; toMs: number }[] = [],
): Promise<ToolLogWindow> {
  let raw: string;
  try {
    raw = await run([
      'logs',
      'filter-log-events',
      '--log-group-name',
      TOOL_LOG_GROUP,
      '--start-time',
      String(Math.floor(fromMs)),
      '--end-time',
      String(Math.ceil(toMs)),
      '--filter-pattern',
      '"tool call"',
      '--region',
      REGION,
      '--output',
      'json',
      '--no-cli-pager',
    ]);
  } catch (e) {
    return {
      lines: [],
      unavailable: `the tool-call log could not be read (${(e as Error).message.split('\n')[0]})`,
    };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { lines: [], unavailable: 'the tool-call log answered something that is not JSON' };
  }
  const lines: ToolCallLine[] = [];
  for (const ev of parsed?.events ?? []) {
    const at = Number(ev?.timestamp ?? 0);
    const message = String(ev?.message ?? '');
    const start = message.indexOf('{');
    if (start < 0) continue;
    let body: any;
    try {
      body = JSON.parse(message.slice(start));
    } catch {
      continue;
    }
    if (body?.msg !== 'tool call' || !body?.tool) continue;
    const w = windows.find((x) => at >= x.fromMs && at <= x.toMs);
    lines.push({
      at,
      tool: String(body.tool),
      ...(body.section ? { section: String(body.section) } : {}),
      ...(w ? { side: w.side } : {}),
    });
  }
  return { lines };
}

/** Did any turn's own reply expose a call to `tool`? */
export function calledTool(toolActivity: (string[] | undefined)[], tool: string): boolean {
  return toolActivity.some((list) => list?.some((t) => t === tool || t.endsWith(`__${tool}`)));
}
