/**
 * THE ERRAND, AND THE TWO PEOPLE IN IT.
 *
 * These are the fact sheets the founder has been carrying in his head while he
 * ran this rehearsal by hand: he said one opening line, and then answered
 * whatever his assistant asked, truthfully, briefly, volunteering nothing. The
 * sheets below are that — everything the person knows, and nothing else.
 *
 * THE OPENING LINES ARE HIS OWN WORDS, verbatim, and are deliberately not
 * generated: the whole point of the rehearsal is that a real person says a
 * loose, ordinary sentence and the assistant has to do the asking. Everything
 * after the opening is the simulated human answering.
 *
 * WHAT IS NOT IN A SHEET IS NOT KNOWN. Tony has not decided a budget. If his
 * assistant asks what he will pay, the honest answer is that he does not know,
 * and only when pressed for a ceiling does $25 come out. An assistant that ends
 * up with a figure on Tony's card without asking has invented one, and S1 says
 * so.
 */

export interface FactSheet {
  /** The name the transcript writes: `**Alex:**`. */
  name: string;
  side: 'seller' | 'buyer';
  /** First name and locality the account is minted with. */
  firstName: string;
  locality: string;
  /** The suburb the names step should carry, where the sheet has one. */
  suburb?: string;
  /** The first thing they say, in their own words. Fixed. */
  opening: string;
  /** Everything they know, as lines a small model is told to answer from. */
  facts: string[];
  /**
   * Figures this person may state, and only when asked. Anything else on a
   * card or in a message is an assistant's invention — see checks/figures.ts.
   */
  figuresTheyMayGive: number[];
}

export const ALEX: FactSheet = {
  name: 'Alex',
  side: 'seller',
  firstName: 'Alex',
  locality: 'Queanbeyan',
  suburb: 'Queanbeyan',
  opening:
    'I have an upgraded spring for a Fanatec sim racing pedal set I no longer need, want to see if we can get something for it?',
  facts: [
    'You are Alex. You live in Queanbeyan, New South Wales, Australia.',
    'The thing you are selling is a Fanatec ClubSport V3 brake performance spring — the stiffer upgrade spring for the brake pedal.',
    'You have used it for about a year. It is in good condition; nothing is bent or broken.',
    'It is the spring only. No elastomers and no tool go with it.',
    'You want to sell it by best offer — everybody who is interested puts in one figure — rather than naming an asking price.',
    'You would not take less than $10 for it. Only say that number if you are asked what your lowest is, or what you want for it.',
    'You are happy to post it anywhere in Australia. The buyer pays the postage.',
    'You do not know what these usually sell for.',
    'You have no other sim racing gear to sell.',
  ],
  figuresTheyMayGive: [10],
};

export const TONY: FactSheet = {
  name: 'Tony',
  side: 'buyer',
  firstName: 'Tony',
  locality: 'Canberra',
  suburb: 'Franklin',
  // Two utterances: the advice question first, then the want, in his own words.
  opening: 'I have Fanatec ClubSport V3 pedals, would an upgraded brake spring help?',
  facts: [
    'You are Tony. You live in Franklin, a suburb of Canberra, Australian Capital Territory, Australia.',
    'You own a set of Fanatec ClubSport V3 pedals.',
    'You want a used upgraded brake spring for them. Used is fine — you would prefer used.',
    // The founder's own position in the hand runs: "we are trying to match the
    // spring, even if the brake performance kit is probably the better part."
    // Without this line the simulated buyer agreed to whatever alternative his
    // assistant raised, the want went up as "a brake mod, elastomers or a
    // die-spring", and it only nearly met a seller who had exactly the spring.
    'It is the SPRING you want: the stiffer upgrade brake spring. If your assistant suggests something else instead (an elastomer kit, a die-spring mod, a whole kit), say thanks but no, you just want the spring. You do not know its part number or exact name.',
    'You have NOT decided what you are willing to pay. If you are asked about a budget or a price, say you are not sure and ask what they usually go for.',
    'Only if you are pushed a second time for the most you would pay, say $25.',
    'You are fine with it being posted to you.',
    'You are not in a hurry.',
    'If your assistant suggests a budget figure, do not simply agree to theirs: say the most you would pay is $25.',
  ],
  figuresTheyMayGive: [25],
};

/** Tony's second opening, said after his assistant has answered the advice question. */
export const TONY_WANT =
  "I'd still like a used upgraded brake spring for them, find me a used one please";

export const SHEETS = { seller: ALEX, buyer: TONY } as const;

/**
 * The shelf this item does NOT belong on. Run after run the assistants have
 * reached for the car parts branch because the word "pedal" is in it; a sim
 * racing spring is a computer peripheral part, not a motoring part, and a
 * seller card and a buyer card that land on different top-level branches never
 * meet.
 */
export const FORBIDDEN_CATEGORY_PREFIX = 'goods.motoring';

/** Words that identify the thing, for the "the posting says what it is" check. */
export const IDENTIFYING_WORDS = [
  'fanatec',
  'clubsport',
  'v3',
  'brake',
  'spring',
  'pedal',
  'performance',
  'sim',
  'racing',
];

/** Words that say what state it is in. */
export const CONDITION_WORDS = [
  'used',
  'second-hand',
  'secondhand',
  'good condition',
  'good',
  'about a year',
  'a year old',
  'pre-owned',
  'preowned',
  'worn',
];
