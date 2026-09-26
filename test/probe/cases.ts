/**
 * The edge-case probe's use cases: what a reasonable assistant would post for
 * each, written the way one would after reading publish_intent's description.
 *
 * Each case names its actors (one throwaway dev account each, bootstrapped the
 * way the integration suite does it) and the postings each actor makes, in
 * order. `extra` is what the assistant would add if the switchboard came back
 * asking for more detail (the obvious facts a human would give); after that the
 * answerer falls back to `detail_unknown`.
 *
 * Every case sits in its own real town, so one case's postings never meet
 * another's on the shared dev board.
 */

export type Listing = Record<string, unknown>;

export interface Posting {
  /** A short label for the report, e.g. "have: 12 camping chairs". */
  label: string;
  listing: Listing;
  /** Attributes the assistant would add on a NEEDS_DETAIL, the human's obvious answers. */
  extra?: Record<string, string | number | boolean>;
}

export interface Actor {
  key: string;
  firstName: string;
  locality: string;
  postings: Posting[];
}

export interface Case {
  n: number;
  title: string;
  actors: Actor[];
  /** Pairs we would expect an introduction between (actor keys). Empty = none expected. */
  expectPairs: [string, string][];
  /** Wait for introductions at all (false for single-actor cases). */
  waitForMatches: boolean;
  note?: string;
}

const AUD = 'AUD';
const radius = (place: string, km = 25) => ({ place, reach: 'radius', radius_km: km });

export const CASES = (sv: string): Case[] => {
  const want = (o: Listing): Listing => ({ schema_version: sv, type: 'looking_for', ttl_days: 1, ...o });
  const have = (o: Listing): Listing => ({ schema_version: sv, type: 'offering', ttl_days: 1, ...o });

  return [
    {
      n: 1,
      title: 'Store with stock: 8 different haves from one account',
      waitForMatches: false,
      expectPairs: [],
      actors: [
        {
          key: 'store',
          firstName: 'Dana',
          locality: 'Geelong',
          postings: [
            ['office chair', 'goods.furniture.office-chair', 40, { condition: 'good', colour: 'black', adjustable: true }],
            ['desk lamp', 'goods.home.lighting', 15, { condition: 'like new', type: 'LED desk lamp' }],
            ['kids bike', 'goods.bicycle.kids', 60, { wheel_size_in: 20, condition: 'good' }],
            ['toaster', 'goods.appliances.kitchen.toaster', 12, { slices: 4, condition: 'good' }],
            ['bookshelf', 'goods.furniture.bookcase', 35, { material: 'pine', shelves: 5 }],
            ['microwave', 'goods.appliances.kitchen.microwave', 45, { watts: 1000, condition: 'good' }],
            ['coffee table', 'goods.furniture.table', 30, { material: 'oak veneer', shape: 'rectangular' }],
            ['guitar amp', 'goods.music.amps', 80, { watts: 30, brand_model: 'Fender Frontman' }],
          ].map(([kind, category, amount, attributes]) => ({
            label: `have: ${kind} $${amount}`,
            listing: have({
              category,
              kind,
              geo: radius('Geelong', 20),
              ask: { amount, ccy: AUD },
              sale: 'straight',
              attributes,
            }),
          })),
        },
      ],
    },
    {
      n: 2,
      title: 'One have with quantity: 12 identical camping chairs, $15 each',
      waitForMatches: true,
      expectPairs: [
        ['seller', 'buyer1'],
        ['seller', 'buyer2'],
      ],
      actors: [
        {
          key: 'seller',
          firstName: 'Priya',
          locality: 'Ballarat',
          postings: [
            {
              label: 'have: 12 camping chairs, $15 each, slots 10',
              listing: have({
                category: 'goods.furniture.chair',
                kind: 'folding camping chair',
                geo: radius('Ballarat', 25),
                ask: { amount: 15, ccy: AUD },
                sale: 'straight',
                slots: 10,
                attributes: { quantity_available: 12, identical: true, condition: 'good', folding: true, colour: 'green' },
              }),
            },
          ],
        },
        ...['buyer1', 'buyer2'].map((key, i) => ({
          key,
          firstName: i ? 'Sam' : 'Lee',
          locality: 'Ballarat',
          postings: [
            {
              label: 'want: one folding camping chair, up to $20',
              listing: want({
                category: 'goods.furniture.chair',
                kind: 'folding camping chair',
                geo: radius('Ballarat', 25),
                price: { band: { max: 20 }, ccy: AUD },
                attributes: { quantity: 1, folding: true, condition: 'any' },
              }),
            },
          ],
        })),
      ],
    },
    {
      n: 3,
      title: 'Room in a share house (have) and a want for a room',
      waitForMatches: true,
      expectPairs: [['landlord', 'tenant']],
      actors: [
        {
          key: 'landlord',
          firstName: 'Mia',
          locality: 'Newcastle',
          postings: [
            {
              label: 'have: room in a 3-bedroom share house, $220/week',
              listing: have({
                category: 'property.share.room',
                kind: 'room in a share house',
                geo: radius('Newcastle', 10),
                ask: { amount: 220, ccy: AUD },
                sale: 'straight',
                attributes: { rent_period: 'week', bedrooms_in_house: 3, furnished: false, bills_included: true, available_from: '2026-10-10' },
              }),
            },
          ],
        },
        {
          key: 'tenant',
          firstName: 'Tom',
          locality: 'Newcastle',
          postings: [
            {
              label: 'want: room in a share house, up to $250/week',
              listing: want({
                category: 'property.share.room',
                kind: 'room in a share house',
                geo: radius('Newcastle', 10),
                price: { band: { max: 250 }, ccy: AUD },
                attributes: { rent_period: 'week', move_in: 'mid October', furnished: 'either' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 4,
      title: 'Plumber wanted (licensed trade) and electrician offering',
      waitForMatches: false,
      expectPairs: [],
      actors: [
        {
          key: 'homeowner',
          firstName: 'Jo',
          locality: 'Wollongong',
          postings: [
            {
              label: 'want: licensed plumber for a leaking hot water system',
              listing: want({
                category: 'services.trades.plumbing',
                kind: 'licensed plumber',
                geo: radius('Wollongong', 20),
                urgency: 'days',
                attributes: { job: 'leaking hot water system', licensed_required: true },
              }),
            },
          ],
        },
        {
          key: 'sparky',
          firstName: 'Ray',
          locality: 'Wollongong',
          postings: [
            {
              label: 'have: licensed electrician taking small jobs',
              listing: have({
                category: 'services.trades.electrical',
                kind: 'licensed electrician',
                geo: radius('Wollongong', 30),
                attributes: { licensed: true, jobs: 'small domestic jobs, power points, lights' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 5,
      title: 'Skill swap posted as two wants (guitar-for-Spanish vs Spanish-for-guitar)',
      waitForMatches: true,
      expectPairs: [['guitarLearner', 'spanishLearner']],
      note: 'Both halves are wants; nothing opposite exists unless the switchboard reads the offer inside each.',
      actors: [
        {
          key: 'guitarLearner',
          firstName: 'Ana',
          locality: 'Hobart',
          postings: [
            {
              label: 'want: guitar lessons, can teach Spanish in exchange',
              listing: want({
                category: 'services.lessons.guitar',
                kind: 'beginner guitar lessons',
                geo: radius('Hobart', 15),
                attributes: { level: 'beginner', in_exchange: 'Spanish lessons (native speaker)', payment: 'swap, no money' },
              }),
            },
          ],
        },
        {
          key: 'spanishLearner',
          firstName: 'Ben',
          locality: 'Hobart',
          postings: [
            {
              label: 'want: Spanish lessons, can teach guitar in exchange',
              listing: want({
                category: 'services.tutoring.languages',
                kind: 'Spanish lessons',
                geo: radius('Hobart', 15),
                attributes: { language: 'Spanish', level: 'beginner', in_exchange: 'guitar lessons (ten years playing)', payment: 'swap, no money' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 6,
      title: 'Item-for-item trade: PS5 for a bike, both sides post a have and a want',
      waitForMatches: true,
      expectPairs: [['ps5Owner', 'bikeOwner']],
      actors: [
        {
          key: 'ps5Owner',
          firstName: 'Kai',
          locality: 'Townsville',
          postings: [
            {
              label: 'have: PS5, to trade for a bike',
              listing: have({
                category: 'goods.electronics.console.playstation',
                kind: 'PlayStation 5',
                geo: radius('Townsville', 25),
                attributes: { model: 'PS5 disc edition', condition: 'good', controllers: 1, trade_for: 'bike (mountain or hybrid)' },
              }),
            },
            {
              label: 'want: bike, will trade a PS5',
              listing: want({
                category: 'goods.bicycle',
                kind: 'bike',
                geo: radius('Townsville', 25),
                attributes: { type: 'mountain or hybrid', frame_size: 'medium', trade_offered: 'PS5' },
              }),
            },
          ],
        },
        {
          key: 'bikeOwner',
          firstName: 'Zoe',
          locality: 'Townsville',
          postings: [
            {
              label: 'have: mountain bike, to trade for a PS5',
              listing: have({
                category: 'goods.bicycle.mountain',
                kind: 'mountain bike',
                geo: radius('Townsville', 25),
                attributes: { frame_size: 'medium', wheel_size_in: 29, condition: 'good', trade_for: 'PS5' },
              }),
            },
            {
              label: 'want: PS5, will trade a mountain bike',
              listing: want({
                category: 'goods.electronics.console.playstation',
                kind: 'PlayStation 5',
                geo: radius('Townsville', 25),
                attributes: { condition: 'working', trade_offered: 'mountain bike' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 7,
      title: 'Group buy: three wants for a share of a bulk coffee order vs one have',
      waitForMatches: true,
      expectPairs: [
        ['organiser', 'share1'],
        ['organiser', 'share2'],
        ['organiser', 'share3'],
      ],
      actors: [
        {
          key: 'organiser',
          firstName: 'Nat',
          locality: 'Cairns',
          postings: [
            {
              label: 'have: 3 shares of a 5kg bulk coffee bean order, $45 a share, slots 3',
              listing: have({
                category: 'goods.food.coffee-beans',
                kind: 'share of bulk coffee order',
                geo: radius('Cairns', 20),
                ask: { amount: 45, ccy: AUD },
                sale: 'straight',
                slots: 3,
                attributes: { share_size: '1kg', shares_available: 3, roast: 'medium', beans: 'whole', order_closes: 'next Friday' },
              }),
            },
          ],
        },
        ...['share1', 'share2', 'share3'].map((key, i) => ({
          key,
          firstName: ['Ivy', 'Oli', 'Raj'][i],
          locality: 'Cairns',
          postings: [
            {
              label: 'want: a 1kg share of a bulk coffee order, up to $50',
              listing: want({
                category: 'goods.food.coffee-beans',
                kind: 'share of bulk coffee order',
                geo: radius('Cairns', 20),
                price: { band: { max: 50 }, ccy: AUD },
                attributes: { share_size: '1kg', beans: 'whole' },
              }),
            },
          ],
        })),
      ],
    },
    {
      n: 8,
      title: 'Recommendation ask: a good dentist in Canberra',
      waitForMatches: false,
      expectPairs: [],
      actors: [
        {
          key: 'asker',
          firstName: 'Ella',
          locality: 'Canberra',
          postings: [
            {
              label: 'want: a good dentist recommendation in Canberra',
              listing: want({
                category: 'services.health.dental',
                kind: 'dentist recommendation',
                geo: radius('Canberra', 20),
                attributes: { what: 'a recommendation for a good, gentle dentist', for: 'adult check-up and clean' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 9,
      title: 'Free giveaway: free couch, pick up only; and a want for a free couch',
      waitForMatches: true,
      expectPairs: [['giver', 'taker']],
      actors: [
        {
          key: 'giver',
          firstName: 'Gus',
          locality: 'Toowoomba',
          postings: [
            {
              label: 'have: free 3-seater couch, pick up only (price band 0-0)',
              listing: have({
                category: 'goods.furniture.sofa',
                kind: 'three seater couch',
                geo: radius('Toowoomba', 15),
                price: { band: { min: 0, max: 0 }, ccy: AUD },
                attributes: { seats: 3, free: true, pickup_only: true, condition: 'worn but clean', colour: 'grey' },
              }),
            },
          ],
        },
        {
          key: 'taker',
          firstName: 'Liv',
          locality: 'Toowoomba',
          postings: [
            {
              label: 'want: free couch (budget 0), can pick up',
              listing: want({
                category: 'goods.furniture.sofa',
                kind: 'couch',
                geo: radius('Toowoomba', 15),
                price: { band: { max: 0 }, ccy: AUD },
                attributes: { free_only: true, can_pick_up: true, seats: 3 },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 10,
      title: 'Borrow/lend a ladder for a day; trailer for hire $40/day',
      waitForMatches: true,
      expectPairs: [
        ['borrower', 'lender'],
        ['trailerHirer', 'trailerOwner'],
      ],
      actors: [
        {
          key: 'borrower',
          firstName: 'Max',
          locality: 'Bendigo',
          postings: [
            {
              label: 'want: borrow an extension ladder for a day',
              listing: want({
                category: 'goods.tools.ladder',
                kind: 'extension ladder to borrow',
                geo: radius('Bendigo', 10),
                attributes: { arrangement: 'borrow', duration: 'one day', when: 'this Saturday', min_height_m: 4 },
              }),
            },
          ],
        },
        {
          key: 'lender',
          firstName: 'Ruth',
          locality: 'Bendigo',
          postings: [
            {
              label: 'have: extension ladder to lend',
              listing: have({
                category: 'goods.tools.ladder',
                kind: 'extension ladder to lend',
                geo: radius('Bendigo', 10),
                attributes: { arrangement: 'lend', height_m: 6, type: 'aluminium extension', return_within: 'a day or two' },
              }),
            },
          ],
        },
        {
          key: 'trailerOwner',
          firstName: 'Hal',
          locality: 'Bendigo',
          postings: [
            {
              label: 'have: box trailer for hire, $40/day',
              listing: have({
                category: 'goods.vehicles.trailer',
                kind: 'box trailer for hire',
                geo: radius('Bendigo', 20),
                ask: { amount: 40, ccy: AUD },
                sale: 'straight',
                attributes: { arrangement: 'hire', rate_period: 'day', size: '7x4', caged: false },
              }),
            },
          ],
        },
        {
          key: 'trailerHirer',
          firstName: 'Pip',
          locality: 'Bendigo',
          postings: [
            {
              label: 'want: hire a box trailer for a day, up to $50',
              listing: want({
                category: 'goods.vehicles.trailer',
                kind: 'box trailer hire',
                geo: radius('Bendigo', 20),
                price: { band: { max: 50 }, ccy: AUD },
                attributes: { arrangement: 'hire', duration: 'one day', when: 'next weekend' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 11,
      title: 'Lost/found pet: lost brown kelpie in Braddon; found one',
      waitForMatches: true,
      expectPairs: [['owner', 'finder']],
      actors: [
        {
          key: 'owner',
          firstName: 'Beth',
          locality: 'Braddon',
          postings: [
            {
              label: 'want: lost my dog, brown kelpie, Braddon',
              listing: want({
                category: 'social.community.lost-and-found',
                kind: 'lost dog',
                geo: radius('Braddon', 10),
                urgency: 'today',
                attributes: { animal: 'dog', breed: 'kelpie', colour: 'brown', last_seen: 'Braddon, yesterday evening', collar: 'red' },
              }),
            },
          ],
        },
        {
          key: 'finder',
          firstName: 'Carl',
          locality: 'Braddon',
          postings: [
            {
              label: 'have: found a brown kelpie in Braddon',
              listing: have({
                category: 'social.community.lost-and-found',
                kind: 'found dog',
                geo: radius('Braddon', 10),
                urgency: 'today',
                attributes: { animal: 'dog', breed: 'kelpie', colour: 'brown', found_where: 'Braddon', collar: 'red' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 12,
      title: 'Dated event: hiking group Sat 4 Oct 2026, room for 6, two wants to join',
      waitForMatches: true,
      expectPairs: [
        ['host', 'hiker1'],
        ['host', 'hiker2'],
      ],
      actors: [
        {
          key: 'host',
          firstName: 'Fay',
          locality: 'Launceston',
          postings: [
            {
              label: 'have: hiking group Sat 4 Oct 2026, room for 6 (slots 6, ttl 8 days)',
              listing: have({
                category: 'social.activity-partner.hiking',
                kind: 'Saturday hiking group',
                geo: radius('Launceston', 30),
                slots: 6,
                ttl_days: 8,
                attributes: { date: '2026-10-04', day: 'Saturday', start_time: '08:00', difficulty: 'moderate', distance_km: 12, spots: 6 },
              }),
            },
          ],
        },
        ...['hiker1', 'hiker2'].map((key, i) => ({
          key,
          firstName: i ? 'Ned' : 'Una',
          locality: 'Launceston',
          postings: [
            {
              label: 'want: join a hiking group this weekend',
              listing: want({
                category: 'social.activity-partner.hiking',
                kind: 'hiking group to join',
                geo: radius('Launceston', 30),
                ttl_days: 8,
                attributes: { when: 'weekend of 4 October 2026', difficulty: 'moderate' },
              }),
            },
          ],
        })),
      ],
    },
    {
      n: 13,
      title: 'Non-English: a want in Spanish for a used bicycle vs an English have',
      waitForMatches: true,
      expectPairs: [['hispano', 'seller']],
      actors: [
        {
          key: 'hispano',
          firstName: 'Luis',
          locality: 'Darwin',
          postings: [
            {
              label: 'want (Spanish): bicicleta usada, hasta $200',
              listing: want({
                category: 'goods.bicycle',
                kind: 'bicicleta usada',
                geo: radius('Darwin', 20),
                price: { band: { max: 200 }, ccy: AUD },
                attributes: { tipo: 'bicicleta de paseo o híbrida', talla_cuadro: 'mediana', estado: 'usada, en buen estado', uso: 'ir al trabajo' },
              }),
              extra: { descripcion: 'busco una bicicleta usada para ir al trabajo, cuadro mediano' },
            },
          ],
        },
        {
          key: 'seller',
          firstName: 'Amy',
          locality: 'Darwin',
          postings: [
            {
              label: 'have: used hybrid bike, $150',
              listing: have({
                category: 'goods.bicycle.hybrid',
                kind: 'used hybrid bike',
                geo: radius('Darwin', 20),
                ask: { amount: 150, ccy: AUD },
                sale: 'straight',
                attributes: { frame_size: 'medium', condition: 'good', gears: 21 },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 14,
      title: 'Travelling: home is Canberra, wants a surfboard to hire in Byron Bay next week',
      waitForMatches: true,
      expectPairs: [['traveller', 'byronLocal']],
      note: 'A Byron Bay local posts the counterpart have so the pair can be observed.',
      actors: [
        {
          key: 'traveller',
          firstName: 'Ivan',
          locality: 'Canberra',
          postings: [
            {
              label: 'want: surfboard hire in Byron Bay next week (home area Canberra)',
              listing: want({
                category: 'goods.sports.water.surf',
                kind: 'surfboard hire',
                geo: radius('Byron Bay', 10),
                ttl_days: 10,
                attributes: { arrangement: 'hire', board: 'longboard or mal', skill: 'intermediate', dates: 'next week, about 3 days' },
              }),
            },
          ],
        },
        {
          key: 'byronLocal',
          firstName: 'Rhys',
          locality: 'Byron Bay',
          postings: [
            {
              label: 'have: longboard for hire in Byron Bay, $30/day',
              listing: have({
                category: 'goods.sports.water.surf',
                kind: 'surfboard hire',
                geo: radius('Byron Bay', 10),
                ask: { amount: 30, ccy: AUD },
                sale: 'straight',
                attributes: { arrangement: 'hire', board: 'longboard', length_ft: 9, rate_period: 'day' },
              }),
            },
          ],
        },
      ],
    },
    {
      n: 15,
      title: 'Tennis partner: two social wants (pre-swap-deploy)',
      waitForMatches: true,
      expectPairs: [['player1', 'player2']],
      note: 'pre-swap-deploy: the swap change for symmetric social wants is not on dev yet.',
      actors: ['player1', 'player2'].map((key, i) => ({
        key,
        firstName: i ? 'Wes' : 'Ada',
        locality: 'Mackay',
        postings: [
          {
            label: 'want: tennis partner for weekend social hits',
            listing: want({
              category: 'social.activity-partner.tennis',
              kind: 'tennis partner',
              geo: radius('Mackay', 15),
              attributes: { level: 'intermediate', when: 'weekend mornings', format: 'social hit, singles' },
            }),
          },
        ],
      })),
    },
    {
      n: 16,
      title: 'Café: 10 leftover pastries at close, free/cheap, today',
      waitForMatches: true,
      expectPairs: [['cafe', 'local']],
      note: 'A local posts a want for cheap pastries today so the pair can be observed.',
      actors: [
        {
          key: 'cafe',
          firstName: 'Bea',
          locality: 'Albury',
          postings: [
            {
              label: 'have: 10 leftover pastries at close today, free or $2 each (urgency today)',
              listing: have({
                category: 'goods.food.pastries',
                kind: 'leftover pastries',
                geo: radius('Albury', 5),
                urgency: 'today',
                ttl_days: 1,
                price: { band: { min: 0, max: 2 }, ccy: AUD },
                slots: 10,
                attributes: { quantity: 10, pickup: 'at close today, 3pm', types: 'croissants and danishes', seller: 'cafe' },
              }),
            },
          ],
        },
        {
          key: 'local',
          firstName: 'Tess',
          locality: 'Albury',
          postings: [
            {
              label: 'want: cheap pastries today',
              listing: want({
                category: 'goods.food.pastries',
                kind: 'cheap pastries',
                geo: radius('Albury', 5),
                urgency: 'today',
                price: { band: { max: 5 }, ccy: AUD },
                attributes: { quantity: 'a few', pickup: 'today' },
              }),
            },
          ],
        },
      ],
    },
  ];
};
