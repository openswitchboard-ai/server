/**
 * Measure the connect payload the way docs/manual-inventory.md measured it:
 * the connect text, the tool descriptions, and the input schemas as they are
 * serialised into a `tools/list` response.
 *
 * Since version 54 the connect text is a page rather than the whole manual,
 * so `manual` here is what an agent is handed at the handshake and `body` is
 * the depth it fetches a section at a time from read_manual.
 */
import { TOOLS } from '../src/mcp/tools.js';
import { MANUAL_BODY, SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js';

const manual = SERVER_INSTRUCTIONS.length;
const body = MANUAL_BODY.length;
const desc = TOOLS.reduce((n, t) => n + t.description.length, 0);
const schema = TOOLS.reduce((n, t) => n + JSON.stringify(t.inputSchema).length, 0);
console.log(
  JSON.stringify(
    {
      manual,
      body,
      desc,
      schema,
      total: manual + desc + schema,
      perTool: TOOLS.map((t) => ({
        name: t.name,
        d: t.description.length,
        s: JSON.stringify(t.inputSchema).length,
      })),
    },
    null,
    1,
  ),
);
