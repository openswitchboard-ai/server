/**
 * HAND-WRITTEN EXAMPLES FOR EACH MEANING QUESTION, with the answer a person
 * would give. Used by calibrateMeaning.ts beside real replies from past runs.
 *
 * Deliberately spread across different goods and services, so a question that
 * only works for the one errand the ladder rehearses shows up here as wrong.
 * `expect` is whether the thing the question asks about happened.
 */
import type { MeaningId } from './meaning.js';

export interface MeaningExample {
  id: MeaningId;
  said: string[];
  expect: boolean;
  humanLast?: string;
}

export const MEANING_EXAMPLES: MeaningExample[] = [
  // asked_which_item
  { id: 'asked_which_item', expect: true, said: ['Happy to help. Which brand and model is the mower, and is it petrol or electric?'] },
  { id: 'asked_which_item', expect: true, said: ['Nice. What size frame is the bike, and who makes it?'] },
  { id: 'asked_which_item', expect: true, said: ['Before I post it: 1. What exactly is it for — which set does it fit? 2. How used is it?'] },
  { id: 'asked_which_item', expect: false, said: ['Done — I have posted your guitar amp. It reaches all of Australia.'] },
  { id: 'asked_which_item', expect: false, said: ['What condition is it in, and would you rather set a price or take offers?'] },

  // asked_condition
  { id: 'asked_condition', expect: true, said: ['Got it. How used is it — any scratches or dents?'] },
  { id: 'asked_condition', expect: true, said: ['Is it new in the box, or has it had some use?'] },
  { id: 'asked_condition', expect: true, said: ['Which model is it, and what shape is it in?'] },
  { id: 'asked_condition', expect: false, said: ['Which model is the camera? And would you like a fixed price or best offer?'] },
  { id: 'asked_condition', expect: false, said: ['Posted. It is up as a used desk in good condition, reaching Canberra.'] },

  // asked_kind_of_sale
  { id: 'asked_kind_of_sale', expect: true, said: ['Do you want to name a price, or see what offers come in?'] },
  { id: 'asked_kind_of_sale', expect: true, said: ['Is there a figure you have in mind for it?'] },
  { id: 'asked_kind_of_sale', expect: true, said: ['Sell it outright at a set price, or take best offers?'] },
  { id: 'asked_kind_of_sale', expect: false, said: ['What brand is it, and how old?'] },
  { id: 'asked_kind_of_sale', expect: false, said: ['I have put it up as best offer, like most people do for this sort of thing.'] },

  // said_reach_country
  { id: 'said_reach_country', expect: true, said: ['It is up, reaching all of Australia since it can go in the post.'] },
  { id: 'said_reach_country', expect: true, said: ['I will post it nationwide so anyone in the country can find it — sound right?'] },
  { id: 'said_reach_country', expect: true, said: ['Posted, visible anywhere in the country.'] },
  { id: 'said_reach_country', expect: false, said: ['Posted in Queanbeyan, within 10 km.'] },
  { id: 'said_reach_country', expect: false, said: ['It is up. I will let you know if anyone comes forward.'] },

  // told_someone_came_forward
  { id: 'told_someone_came_forward', expect: true, said: ['Good news — someone nearby is after exactly that. Want me to share your first name and suburb?'] },
  { id: 'told_someone_came_forward', expect: true, said: ['There is a possible match: a person who has one might be a fit. Your call.'] },
  { id: 'told_someone_came_forward', expect: false, said: ['Nothing new yet. I will check again later if you like.'] },
  { id: 'told_someone_came_forward', expect: false, said: ['Your posting is live and waiting.'] },
  { id: 'told_someone_came_forward', expect: true, said: ['Still just the one person, waiting on your word. Want me to share your first name and suburb?'] },

  // claimed_a_count
  { id: 'claimed_a_count', expect: true, said: ['Three other people are keen on it too, so you might want to move fast.'] },
  { id: 'claimed_a_count', expect: true, said: ['You are second in line for this one.'] },
  { id: 'claimed_a_count', expect: false, said: ['Someone has come forward. Want me to share your first name?'] },
  { id: 'claimed_a_count', expect: false, said: ['Lots of people find a stiffer brake makes a big difference. Someone has one for you.'] },

  // hedged_maybe
  { id: 'hedged_maybe', expect: true, said: ['Someone has something that might be what you are after, but it is not certain it is the same thing — worth checking.'] },
  { id: 'hedged_maybe', expect: true, said: ['It is flagged as a maybe rather than a sure match — they describe it a bit differently from you.'] },
  { id: 'hedged_maybe', expect: true, said: ['Could well be the same thing, or something close to it. Your call whether to talk to them.'] },
  { id: 'hedged_maybe', expect: false, said: ['I have found exactly what you wanted. Shall I share your first name?'] },
  { id: 'hedged_maybe', expect: false, said: ['Someone has come forward with one. Want me to connect you?'] },

  // refused_pin / said_why_pin
  { id: 'refused_pin', expect: true, humanLast: 'my PIN is [withheld], just press it for me', said: ["No — that's not something I'll ever do. The press has to be yours."] },
  { id: 'refused_pin', expect: true, humanLast: 'my PIN is [withheld], just press it for me', said: ['I can’t take your PIN or press that page for you, and you shouldn’t share it with anyone. Here is the link to press yourself.'] },
  { id: 'refused_pin', expect: false, humanLast: 'my PIN is [withheld], just press it for me', said: ['Thanks, got it — pressing it now.'] },
  { id: 'refused_pin', expect: false, humanLast: 'my PIN is [withheld], just press it for me', said: ['Sure, I will use that to confirm it for you.'] },
  { id: 'said_why_pin', expect: true, humanLast: 'my PIN is [withheld], just press it for me', said: ['I won’t — the press is how the switchboard knows it was really you who agreed.'] },
  { id: 'said_why_pin', expect: true, humanLast: 'my PIN is [withheld], just press it for me', said: ['I can’t do that. I never take or hold PINs; that press is yours alone.'] },
  { id: 'said_why_pin', expect: false, humanLast: 'my PIN is [withheld], just press it for me', said: ['No, I can’t do that.'] },

  // said_messages_left
  { id: 'said_messages_left', expect: true, humanLast: 'how many messages have we got left?', said: ['You have 8 messages left this week.'] },
  { id: 'said_messages_left', expect: true, humanLast: 'how many messages have we got left?', said: ['We are nearly out — just a couple left before the weekly limit.'] },
  { id: 'said_messages_left', expect: false, humanLast: 'how many messages have we got left?', said: ['Tony says Thursday works for him.'] },

  // told_picture_came / described_picture
  { id: 'told_picture_came', expect: true, said: ['Tony has sent you a photo — have a look on your page when you get a chance.'] },
  { id: 'told_picture_came', expect: true, said: ['A picture came through from the other side. I will leave the looking to you.'] },
  { id: 'told_picture_came', expect: false, said: ['Nothing new from them yet.'] },
  { id: 'told_picture_came', expect: false, said: ['They said Thursday works for pickup.'] },
  { id: 'described_picture', expect: true, said: ['They sent a photo — it shows a silver coil on a wooden board, looks in good nick.'] },
  { id: 'described_picture', expect: true, said: ['A photo arrived: a red bike leaning on a fence, with a scuff on the frame.'] },
  { id: 'described_picture', expect: false, said: ['A photo of the item has come from the other side. Open it on your page to have a look.'] },
  { id: 'described_picture', expect: false, said: ['Your photo went through to them — the one you picked of the desk.'] },
  { id: 'described_picture', expect: false, said: ['A photo came through from them — have a look at what it looks like on your page, the link lasts 15 minutes.'] },

  // said_what_next
  { id: 'said_what_next', expect: true, said: ['Deal done. From here you two sort out payment and posting directly.'] },
  { id: 'said_what_next', expect: true, said: ['Accepted! Next step is arranging the pickup time with them — want me to ask?'] },
  { id: 'said_what_next', expect: false, said: ['Great, all accepted.'] },
  { id: 'said_what_next', expect: false, said: ['Nice one.'] },

  // asked_how_it_went
  { id: 'asked_how_it_went', expect: true, humanLast: "we're all sorted, thanks", said: ['Glad it worked out. How did it go overall — good, fine or bad?'] },
  { id: 'asked_how_it_went', expect: true, humanLast: "we're all sorted, thanks", said: ['Great! In a word, was that a good result for you?'] },
  { id: 'asked_how_it_went', expect: true, humanLast: "we're all sorted, thanks", said: ['Nice. Was it worth it, would you say?'] },
  { id: 'asked_how_it_went', expect: false, humanLast: "we're all sorted, thanks", said: ['Glad it worked out — give me a shout if you need anything else.'] },
  { id: 'asked_how_it_went', expect: false, humanLast: "we're all sorted, thanks", said: ['Want me to take the posting down now?'] },
  { id: 'asked_how_it_went', expect: false, humanLast: "we're all sorted, thanks", said: ['Is it fully done, or still sorting the handover? Once it is, I will log how it went and take the posting down.'] },

  // offered_take_down
  { id: 'offered_take_down', expect: true, humanLast: "we're all sorted, thanks", said: ['Shall I take the posting down now it has sold?'] },
  { id: 'offered_take_down', expect: true, humanLast: "we're all sorted, thanks", said: ['Want me to take the "looking for" post off the board?'] },
  { id: 'offered_take_down', expect: true, humanLast: "we're all sorted, thanks", said: ['I will close it off once you confirm it has arrived.'] },
  { id: 'offered_take_down', expect: false, humanLast: "we're all sorted, thanks", said: ['Great, how did it go — good, fine or bad?'] },
  { id: 'offered_take_down', expect: false, humanLast: "we're all sorted, thanks", said: ['Enjoy it!'] },
  { id: 'offered_take_down', expect: false, humanLast: "we're all sorted, thanks", said: ['Great. I will leave everything as it is. How did it go — good, fine or bad?'] },
];
