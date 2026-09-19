/**
 * THE SIMULATED HUMAN.
 *
 * The founder's part in these rehearsals is small and strict: say the opening
 * line, then answer whatever the assistant asks, truthfully, briefly, in his
 * own casual words, and VOLUNTEER NOTHING. That is what is modelled here, with
 * the cheapest Haiku-class model the repository already pays for, held to a
 * fact sheet.
 *
 * WHY A MODEL AND NOT A RULE TABLE. duet/persona.ts is a rule table and says so
 * proudly, and for the duet it is right: the duet measures what two AGENTS do
 * to each other and a model in the middle would be a third agent nobody is
 * measuring. This suite measures something else — whether an assistant ASKS the
 * right questions of a person who will not help it — and a rule table cannot be
 * surprised by a question the founder never thought of. The constraint that
 * makes it safe is the sheet: the model is told it knows those lines and
 * nothing else, and every figure the run later finds on a card is checked
 * against the short list of numbers the sheet permits. A simulated human that
 * invents a price is caught by the same check that catches an assistant that
 * invents one.
 *
 * THE PRESS TOKEN. A person handed a link goes and presses it. The simulator
 * cannot, so it says `[[PRESS <url>]]` and the harness presses the page as that
 * human, on their own signed-in session, with their own PIN. The assistant
 * never sees the token and never sees a PIN.
 */
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { HUMAN_MODEL_ID, REGION } from './config.js';
import type { FactSheet } from './scenarios/spring.js';

const bedrock = new BedrockRuntimeClient({ region: REGION });

/** How the simulator asks for a page to be pressed. */
export const PRESS_RE = /\[\[PRESS\s+(https?:\/\/[^\s\]]+)\s*\]\]/gi;

/**
 * Every link the human said they would press, in order, with the token taken
 * out of the words. Exported because the harness presses these and because the
 * transcript should carry what the person SAID, not the marker.
 */
export function extractPresses(said: string): { links: string[]; spoken: string } {
  const links: string[] = [];
  PRESS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRESS_RE.exec(said))) links.push(m[1]);
  const spoken = said.replace(PRESS_RE, 'Pressed it.').replace(/\s+/g, ' ').trim();
  return { links, spoken };
}

export function humanSystemPrompt(sheet: FactSheet): string {
  return [
    `You are ${sheet.name}, a real person talking to your own AI assistant.`,
    '',
    'EVERYTHING YOU KNOW is the list below. There is nothing else in your head.',
    ...sheet.facts.map((f) => `- ${f}`),
    '',
    'HOW YOU TALK:',
    '- Answer ONLY what you were actually asked. One or two short sentences.',
    '- Your own casual words. No lists, no headings, no formatting.',
    '- Never volunteer a fact you were not asked for, however helpful it would be.',
    '- If you are asked something the list above does not cover, say you are not sure.',
    '- Never say you are simulated, an AI, a test, or a model. You are just a person.',
    '- Never offer a price, a budget or any other number unless you were asked for one and the list gives it.',
    // The door now reads a figure back before a posting goes up, so the person
    // is asked "is $45 the figure you gave?" — and the whole value of that
    // question is that the answer is true. A simulated human who agrees to be
    // polite would teach an assistant that inventing one is safe.
    '- If you are asked whether a figure is one you gave, answer truthfully from the list: confirm it if the list gives that exact number, and say "I never gave a figure" if it does not.',
    '- If you are offered a choice, choose the one the list points at; if the list is silent, say you do not mind.',
    `- If you are handed a link to press, reply with exactly: [[PRESS <the url>]] and nothing else.`,
    '',
    'If the assistant said nothing that needs an answer, say something short and ordinary like "ok, thanks".',
  ].join('\n');
}

export interface HumanTurn {
  role: 'assistant' | 'human';
  text: string;
}

export interface Simulator {
  /** What this person says next, having heard `assistantSaid`. */
  reply(history: HumanTurn[], assistantSaid: string): Promise<string>;
}

/** The real thing: one Bedrock call per human turn. */
export function bedrockSimulator(sheet: FactSheet): Simulator {
  const system = humanSystemPrompt(sheet);
  return {
    async reply(history, assistantSaid) {
      const messages = [
        ...history.map((t) => ({
          role: t.role === 'human' ? ('assistant' as const) : ('user' as const),
          content: t.text,
        })),
        { role: 'user' as const, content: assistantSaid },
      ];
      const r = await bedrock.send(
        new InvokeModelCommand({
          modelId: HUMAN_MODEL_ID,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 160,
            temperature: 0.4,
            system,
            messages: messages.length ? messages : [{ role: 'user', content: 'Hello?' }],
          }),
        }),
      );
      const parsed = JSON.parse(new TextDecoder().decode(r.body));
      const text: string = (parsed.content ?? []).map((c: any) => c?.text ?? '').join('').trim();
      // A model that says nothing is a mechanical failure, not a silent human.
      if (!text) throw new Error('the simulated human produced no words');
      return text;
    },
  };
}

/**
 * The stub `--dry` uses. No network, no model, no AWS.
 *
 * It answers from the sheet by keyword, which is enough to drive the
 * orchestration through every branch, and it says so: a dry run's transcript is
 * marked dry and is never scored or reported as a real rehearsal.
 */
export function cannedSimulator(sheet: FactSheet): Simulator {
  let turn = 0;
  return {
    async reply(_history, assistantSaid) {
      turn++;
      const said = assistantSaid.toLowerCase();
      const link = assistantSaid.match(/https?:\/\/\S+/)?.[0];
      if (link && /press|link|page|open/.test(said)) return `[[PRESS ${link}]]`;
      if (/pin/.test(said)) return 'ok, I will do it myself then.';
      // The figure read back at the door, answered the way the sheet answers it.
      if (/\bis \$?\d/.test(said) && /figure you gave|put there myself/.test(said)) {
        return sheet.side === 'seller' ? "yeah, $10 is what I said." : 'I never gave a figure.';
      }
      if (/photo|picture/.test(said)) return 'yeah I can send a photo of it.';
      if (/budget|pay|price|how much|offer|worth/.test(said)) {
        return sheet.side === 'buyer'
          ? 'not sure, what do they usually go for?'
          : "I wouldn't take less than $10 for it.";
      }
      if (/condition|how old|used|state/.test(said)) {
        return sheet.side === 'seller'
          ? 'used it about a year, good condition, spring only.'
          : 'used is fine by me.';
      }
      if (/make|model|which|what kind|brand/.test(said)) {
        return sheet.side === 'seller'
          ? "it's the ClubSport V3 brake performance spring."
          : "I've got the ClubSport V3 pedals.";
      }
      if (/post|deliver|ship|pick ?up|collect/.test(said)) {
        return sheet.side === 'seller'
          ? "happy to post anywhere in Australia, buyer pays postage."
          : 'posting is fine.';
      }
      if (/straight|best offer|kind of sale|asking price/.test(said)) {
        return sheet.side === 'seller' ? 'best offer I think.' : 'whatever works.';
      }
      return turn > 6 ? 'ok, thanks.' : 'sure.';
    },
  };
}
