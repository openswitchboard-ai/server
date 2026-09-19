/**
 * Write the whole manual to docs/manual.md.
 *
 * The manual is served in pieces now: a short page at connect, the rules on
 * each tool, and one section at a time from read_manual. Nothing hands an
 * agent the whole of it any more, and the whole of it is still what a person
 * reads when they want to know what this switchboard tells assistants to do.
 * So the public copy is rendered from the same constants the server serves,
 * by `npm run render-manual`, and committed.
 *
 * It writes a file and nothing else: no network, no database, no keys.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANUAL, MANUAL_SECTIONS, SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../docs/manual.md');

export function renderManual(): string {
  const parts: string[] = [];
  parts.push(`# The OpenSwitchboard agent manual, version ${MANUAL.version}`);
  parts.push(
    'This is what the switchboard tells an AI assistant to do. It reaches an ' +
      'assistant in three places: the short page below, served in the MCP ' +
      'handshake; the rules on each tool, which every client delivers whole; ' +
      'and these sections, served one at a time by the `read_manual` tool. ' +
      'Nothing here is secret, and nothing here ever asks an assistant to keep ' +
      'something from the person it acts for.\n\n' +
      'This file is generated: `npm run render-manual` writes it from ' +
      '`src/mcp/instructions.ts`, so edit the manual there.',
  );
  parts.push('## What an assistant is handed at connect');
  parts.push(SERVER_INSTRUCTIONS);
  parts.push('## The sections');
  parts.push(MANUAL_SECTIONS.map((s) => `- **${s.id}** — ${s.about}`).join('\n'));
  for (const section of MANUAL_SECTIONS) {
    parts.push(`## ${section.id}`);
    parts.push(`*${section.about}*`);
    parts.push(section.text);
  }
  parts.push('## whats_new');
  parts.push('*What has changed in the manual, newest first.*');
  parts.push(
    [...MANUAL.changelog]
      .sort((a, b) => b.version - a.version)
      .map((c) => `**${c.version}.** ${c.note}`)
      .join('\n\n'),
  );
  return `${parts.join('\n\n')}\n`;
}

writeFileSync(out, renderManual());
process.stdout.write(`wrote ${out}\n`);
