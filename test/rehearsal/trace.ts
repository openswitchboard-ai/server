/**
 * WHAT AN ASSISTANT ACTUALLY SENT, READ OFF ITS OWN RECORD OF THE RUN.
 *
 * The server's tool-call log carries names only, by design, so the arguments
 * of a call (the items of a list and the figures on them) are read from the
 * client's own transcript (box.ts sessionTrace for OpenClaw, the Claude Code
 * driver's trace). Two shapes are read, and nothing else is assumed:
 *
 *   OpenClaw     { type: "toolCall", name: "openswitchboard__publish_list", arguments: {...} }
 *   Claude Code  { type: "tool_use", name: "mcp__openswitchboard__publish_list", input: {...} }
 *
 * Pure: a string in, the calls out. A trace that cannot be read gives no
 * calls, and the check that reads them says so rather than passing.
 */

export interface TracedCall {
  name: string;
  args: Record<string, unknown>;
  /** When the client wrote it down, where it says. */
  at?: string;
}

/** Every tool call in a trace whose name ends with `tool`. */
export function tracedCalls(trace: string | undefined, tool: string): TracedCall[] {
  if (!trace) return [];
  const out: TracedCall[] = [];
  for (const raw of trace.split('\n')) {
    const line = raw.includes('\t') ? raw.slice(raw.indexOf('\t') + 1) : raw;
    if (!line.includes(tool)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    const at = (doc as { timestamp?: unknown })?.timestamp;
    const walk = (v: unknown, depth: number): void => {
      if (!v || typeof v !== 'object' || depth > 8) return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
        return;
      }
      const o = v as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : '';
      const args = o.type === 'toolCall' ? o.arguments : o.type === 'tool_use' ? o.input : undefined;
      if (name.endsWith(tool) && args && typeof args === 'object') {
        out.push({ name, args: args as Record<string, unknown>, ...(typeof at === 'string' ? { at } : {}) });
        return;
      }
      for (const x of Object.values(o)) walk(x, depth + 1);
    };
    walk(doc, 0);
  }
  return out;
}

/** Every figure a list call carried on its items: asking prices and private limits. */
export function figuresSentOnLists(calls: TracedCall[]): { call: number; name: string; amount: number }[] {
  const out: { call: number; name: string; amount: number }[] = [];
  calls.forEach((c, i) => {
    const items = Array.isArray(c.args.items) ? (c.args.items as Record<string, unknown>[]) : [];
    for (const it of items) {
      for (const k of ['price', 'price_limit']) {
        const n = Number(it?.[k]);
        if (it?.[k] !== undefined && Number.isFinite(n)) out.push({ call: i + 1, name: String(it?.name ?? '?'), amount: n });
      }
    }
  });
  return out;
}
