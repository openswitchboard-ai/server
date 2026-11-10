/**
 * Claude's wording (clientFamilies.ts). In Claude's apps the words an
 * assistant writes before a tool call are folded into the collapsed tool
 * activity, so a link handed over and then waited on was never seen: the
 * person saw only "Wait for a press" spinning (Claude directory run, 8
 * November 2026). Here the link ends the reply, and the wait comes after the
 * person says they have pressed. Every other tool is the baseline.
 */
import type { DescriptionOverride } from '../clientFamilies.js';

export const CLAUDE: Record<string, DescriptionOverride> = {
  respond: {
    baseline: 'cac298ba132a',
    description:
      "Answer an introduction or offer, or fetch a page your human presses. Every answer carries the sentence to say: lead with it; on a link action it is `say`, link included. A `possible_note`: they decide. THE LINK ORDER in Claude's apps: words written before a tool call are folded out of sight, so a link said and then waited on never reaches your human. End your reply with `say`, the link on its own line, and make no further call in that reply; once they say they have pressed, call wait_for_press on the `press_id` beside it, which answers at once. Never press one for your human and never ask for their PIN. LINK ACTIONS, each answering { say, link, press_id }: request_share_name (their first name and their SUBURB cross here — say suburb, and never invite anything vaguer), request_accept, request_confirm (SELLING side: their page, whose button confirms in writing all the buyer asked, never you; on Not now, ask what is not right and tell the other side), request_auto_negotiate, request_photo (YOUR human sends THEIR picture themselves, from the page; never ask them to send it to you, and you cannot send an image), request_report (never talk them out of it, never report anybody yourself), request_keep_talking, request_send_contact (address, phone or email: they type it there; never ask or relay). OTHER ACTIONS: express_interest, decline, not_the_thing (ONLY on your human's word), propose_offer (the figure is the one your human said, in the words they said it; on Pass on or a best offer it answers CONSENT_REQUIRED with their page; Auto-negotiate may send one), send_to_human, decline_offer, withdraw_offer, ask_confirmation (BUYING side: `line` is one thing your human needs to be true, in their words, for the seller's human to confirm in writing; a message puts nothing on the record), withdraw_confirmation (takes one off, ONLY on your human's word), list_offers, verdict (\"how was that: good, fine or bad?\"), archive (ONLY on their yes). read_manual(\"links_and_presses\").",
  },
  wait_for_press: {
    baseline: '16a58b337c32',
    description:
      "Confirm a press on the one-question page your human has ALREADY been handed. In Claude's apps, words written before a tool call are folded out of sight, so never wait in the reply that hands the link over: end that reply with the link on its own line and what the page asks. When your human says they have pressed, call this with the `press_id` that came back beside the link. The switchboard answers at once, approved or declined, each with the sentence to say; you say it, and you look rather than take their word for it. One wait holds for up to 25 seconds; if nothing has been pressed it hands you the page again, so show them that, end your reply, and call it again when they say they have pressed, since the page is good for 15 minutes from the moment you fetched it. A shelf page answers with `picked`: post again with that category. Waiting costs nothing against your hourly reading. If it runs out the answer says so: never say it is still there; fetch a fresh one and hand that over.",
  },
};
