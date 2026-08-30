/**
 * MCP tool definitions and dispatch. Input schemas embed the protocol's JSON
 * Schemas from @openswitchboard/schema (bundled self-contained). Tool errors
 * use the protocol's machine-readable error shape.
 */
import { bundledSchema, OsbError, ProtocolError, SCHEMA_VERSION } from '../protocol.js';
import * as cards from '../domain/cards.js';
import * as matches from '../domain/matches.js';
import * as offers from '../domain/offers.js';
import type { Config } from '../config.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
}

const intentCardSchema = bundledSchema('intent-card');

export const TOOLS: ToolDef[] = [
  {
    name: 'publish_intent',
    description:
      'Post a WANT or HAVE intent card for your human. The card is validated against the OpenSwitchboard intent-card schema, screened, and then matched anonymously. The price band (budget ceiling on a WANT, reserve floor on a HAVE) is a private matching input and is never shown to a counterparty.',
    inputSchema: {
      type: 'object',
      properties: { card: intentCardSchema },
      required: ['card'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_intents',
    description: "List your human's intent cards and their lifecycle states.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'check_matches',
    description:
      'Check matches for your intents. Returns stage-appropriate protocol payloads: match.signal (stage 1), match.attributes (stage 2, after mutual interest), match.mutual (stage 3, only after BOTH humans opt in). Pass match_id + stage to fetch one specific stage payload; a locked stage returns STAGE_LOCKED.',
    inputSchema: {
      type: 'object',
      properties: {
        intent_id: { type: 'string', format: 'uuid', description: 'Limit to one intent.' },
        match_id: { type: 'string', format: 'uuid', description: 'Fetch payloads for one match.' },
        stage: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'With match_id: fetch exactly this disclosure stage.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'respond',
    description:
      'Respond to a match or an offer. Actions: express_interest (stage 1->2), opt_in (record your human\'s stage-3 opt-in — only with their explicit approval), decline (no reason carried, by design), propose_offer, send_to_human (park an offer as awaiting-human — the only accept-direction action an agent has; acceptance itself happens in your human\'s own interface), decline_offer, withdraw_offer, list_offers.',
    inputSchema: {
      type: 'object',
      properties: {
        match_id: { type: 'string', format: 'uuid' },
        action: {
          type: 'string',
          enum: [
            'express_interest',
            'opt_in',
            'decline',
            'propose_offer',
            'send_to_human',
            'decline_offer',
            'withdraw_offer',
            'list_offers',
          ],
        },
        offer_id: { type: 'string', format: 'uuid', description: 'Required for offer actions on an existing offer.' },
        offer: {
          type: 'object',
          description: 'Required for propose_offer.',
          properties: {
            amount: { type: 'number', exclusiveMinimum: 0 },
            ccy: { type: 'string', pattern: '^[A-Z]{3}$' },
            expiry: { type: 'string', format: 'date-time' },
            message: { type: 'string', maxLength: 2000 },
          },
          required: ['amount', 'ccy', 'expiry'],
          additionalProperties: false,
        },
      },
      required: ['match_id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_channel',
    description:
      'Open the stage-4 direct channel for a match. Requires stage 3 (both humans opted in). Returns a channel.open payload.',
    inputSchema: {
      type: 'object',
      properties: { match_id: { type: 'string', format: 'uuid' } },
      required: ['match_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'amend_intent',
    description:
      'Amend an intent card (geo, attributes, ask, urgency, status, ttl_days, price). The card is re-validated and re-screened before returning to the network.',
    inputSchema: {
      type: 'object',
      properties: {
        intent_id: { type: 'string', format: 'uuid' },
        patch: {
          type: 'object',
          properties: {
            geo: intentCardSchema.properties.geo,
            attributes: intentCardSchema.properties.attributes,
            ask: intentCardSchema.properties.ask,
            urgency: intentCardSchema.properties.urgency,
            status: intentCardSchema.properties.status,
            ttl_days: intentCardSchema.properties.ttl_days,
            price: intentCardSchema.properties.price,
          },
          additionalProperties: false,
        },
      },
      required: ['intent_id', 'patch'],
      additionalProperties: false,
    },
  },
  {
    name: 'withdraw_intent',
    description: 'Withdraw an intent card from the network.',
    inputSchema: {
      type: 'object',
      properties: { intent_id: { type: 'string', format: 'uuid' } },
      required: ['intent_id'],
      additionalProperties: false,
    },
  },
];

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: any;
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: typeof data === 'object' && data !== null && !Array.isArray(data) ? data : { result: data },
  };
}

function protocolError(payload: ProtocolError): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function invalidInput(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input', message }) }],
    isError: true,
  };
}

export async function dispatchTool(
  cfg: Config,
  accountId: string,
  name: string,
  args: any,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'publish_intent':
        return ok(await cards.publishIntent(cfg, accountId, args?.card));
      case 'list_intents':
        return ok({ intents: await cards.listIntents(accountId) });
      case 'check_matches':
        if (args?.match_id && args?.stage) {
          return ok(await matches.getStagePayload(accountId, args.match_id, args.stage));
        }
        return ok({ matches: await matches.checkMatches(accountId, args?.intent_id) });
      case 'open_channel':
        return ok(await matches.openChannel(args?.match_id, accountId));
      case 'amend_intent':
        return ok(await cards.amendIntent(cfg, accountId, args?.intent_id, args?.patch));
      case 'withdraw_intent':
        return ok(await cards.withdrawIntent(accountId, args?.intent_id));
      case 'respond': {
        const { match_id, action, offer_id, offer } = args ?? {};
        switch (action) {
          case 'express_interest': {
            const m = await matches.expressInterest(match_id, accountId);
            return ok({ match_id, stage_unlocked: m.stage });
          }
          case 'opt_in': {
            const r = await matches.recordStage3OptIn(match_id, accountId, 'agent-attested');
            return ok({
              match_id,
              optin_recorded: true,
              both_recorded: r.both,
              stage_unlocked: r.match.stage,
            });
          }
          case 'decline': {
            await matches.declineMatch(match_id, accountId);
            return ok({ match_id, state: 'declined' });
          }
          case 'propose_offer': {
            if (!offer) return invalidInput('propose_offer requires the offer object');
            return ok(await offers.proposeOffer(cfg, accountId, { match_id, ...offer }));
          }
          case 'send_to_human':
          case 'decline_offer':
          case 'withdraw_offer': {
            if (!offer_id) return invalidInput(`${action} requires offer_id`);
            return ok(await offers.agentOfferAction(cfg, accountId, offer_id, action));
          }
          case 'list_offers':
            return ok({ offers: await offers.listOffers(accountId, match_id) });
          default:
            return invalidInput(`unknown action '${action}'`);
        }
      }
      default:
        return invalidInput(`unknown tool '${name}'`);
    }
  } catch (e: any) {
    if (e instanceof OsbError) return protocolError(e.payload);
    if (e?.notFound) return invalidInput(e.message);
    if (e?.validation) return invalidInput(e.message);
    throw e;
  }
}

export { SCHEMA_VERSION };
