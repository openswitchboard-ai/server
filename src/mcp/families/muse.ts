/**
 * Meta Muse's wording (clientFamilies.ts). Meta's connector guidelines (3.2)
 * ask for tool descriptions that state facts and do not instruct the agent,
 * which is what ChatGPT's wording already does, so Muse starts from that set.
 *
 * One addition, on the tools whose answer is a page the person presses. Muse
 * has a browser of its own inside the chat, shared with the person, and our
 * PIN boxes show their digits as they are typed (pages.ts says why). A PIN
 * typed into a page open in that browser is on Muse's screen. So the page is
 * opened in the person's own browser or phone, and the PIN is never saved in
 * Muse's credential store, from which Muse's browser could press for them.
 */
import type { DescriptionOverride } from '../clientFamilies.js';
import { CHATGPT } from './chatgpt.js';

const OWN_BROWSER =
  " The person opens the page in their own browser or on their phone, not in an assistant's browser, because the PIN shows on screen as it is typed. The PIN or passkey is typed by the person each time and is not saved in an assistant, its browser or a credential store.";

function withOwnBrowser(o: DescriptionOverride): DescriptionOverride {
  return { baseline: o.baseline, description: o.description + OWN_BROWSER };
}

export const MUSE: Record<string, DescriptionOverride> = {
  ...CHATGPT,
  respond: withOwnBrowser(CHATGPT.respond),
  propose_trade: withOwnBrowser(CHATGPT.propose_trade),
  answer_trade: withOwnBrowser(CHATGPT.answer_trade),
};
