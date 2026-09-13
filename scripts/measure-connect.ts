/**
 * Measure the connect payload the way docs/manual-inventory.md measured it:
 * the manual body, the twelve tool descriptions, and the input schemas as they
 * are serialised into a `tools/list` response.
 */
import { TOOLS } from '../src/mcp/tools.js';
import { SERVER_INSTRUCTIONS } from '../src/mcp/instructions.js';

const manual = SERVER_INSTRUCTIONS.length;
const desc = TOOLS.reduce((n, t) => n + t.description.length, 0);
const schema = TOOLS.reduce((n, t) => n + JSON.stringify(t.inputSchema).length, 0);
console.log(
  JSON.stringify(
    {
      manual,
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
