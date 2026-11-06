/**
 * Rewrites the OpenAI part of src/auth/assistantEgress.json from OpenAI's
 * published list of the addresses ChatGPT connectors call out from. The
 * server's registration cap and infra's WAF rate rule both read that file,
 * so a refresh reaches the WAF on the next infra deploy.
 *
 *   npx tsx scripts/refresh-assistant-egress.ts            # fetch the live list
 *   npx tsx scripts/refresh-assistant-egress.ts --from f   # use a saved copy
 *
 * Every entry is checked to be a plain IPv4 or IPv6 CIDR before it is
 * written; anything else stops the script. Anthropic's ranges are short and
 * written by hand in the same JSON (see src/auth/assistantEgress.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://openai.com/chatgpt-connectors.json';
const OUT = fileURLToPath(new URL('../src/auth/assistantEgress.json', import.meta.url));

function checkCidr(c: unknown): string {
  if (typeof c !== 'string') throw new Error(`not a string: ${JSON.stringify(c)}`);
  const [addr, bits, extra] = c.split('/');
  const n = Number(bits);
  const ok = extra === undefined && Number.isInteger(n) && (
    (isIPv4(addr) && n >= 8 && n <= 32) || (isIPv6(addr) && n >= 16 && n <= 128)
  );
  if (!ok) throw new Error(`not a CIDR this script accepts: ${c}`);
  return c;
}

async function main() {
  const i = process.argv.indexOf('--from');
  const raw = i > 0
    ? readFileSync(process.argv[i + 1], 'utf8')
    : await (await fetch(SOURCE, { headers: { 'user-agent': 'openswitchboard-egress-refresh' } })).text();
  const doc = JSON.parse(raw) as { creationTime?: string; prefixes?: Array<Record<string, unknown>> };
  if (!Array.isArray(doc.prefixes) || doc.prefixes.length === 0) throw new Error('no prefixes in the list');
  const cidrs = doc.prefixes.map((p) => checkCidr(p.ipv4Prefix ?? p.ipv6Prefix));
  const created = typeof doc.creationTime === 'string' ? doc.creationTime : 'unknown';
  const all = JSON.parse(readFileSync(OUT, 'utf8'));
  all.openai = { source: SOURCE, created, cidrs };
  const body = `${JSON.stringify(all, null, 2)}\n`;
  writeFileSync(OUT, body);
  console.log(`wrote ${cidrs.length} ranges (list created ${created}) to ${OUT}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
