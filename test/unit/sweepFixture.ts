/**
 * A representative check_in sweep, faked at the pool.
 *
 * One human (Ana) with eight introductions in the shapes a real account
 * collects over a couple of weeks: a fresh maybe, a live conversation with a
 * figure and messages waiting, a deal agreed on a posting the other side has
 * since taken down, a conversation whose other side went quiet after taking
 * theirs down, one taken down only yesterday, one waiting its turn, one filed
 * away and one declined. Used by test/unit/leanSweep.test.ts and by
 * scripts/measure-sweep.test.ts, which prints the size of the same sweep with
 * the lean flag off and on.
 *
 * Callers must mock ../../src/crypto.js themselves (vi.mock is hoisted per
 * file); `cryptoMock` below is the factory to hand it.
 */
import type { Config } from '../../src/config.js';
import { asScreened } from './screenedFixture.js';

export const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side throughout
export const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc';

export const M = (n: number) => `a${String(n).padStart(7, '0')}-1111-4111-8111-aaaaaaaaaaaa`;
const CW = (n: number) => `d${String(n).padStart(7, '0')}-4444-4444-8444-dddddddddddd`;
const CH = (n: number) => `e${String(n).padStart(7, '0')}-5555-4555-8555-eeeeeeeeeeee`;

const DAY = 24 * 60 * 60 * 1000;

export interface FixtureOffer {
  id: string;
  match_id: string;
  proposer_account: string;
  amount: string;
  ccy: string;
  state: string;
  message: unknown;
  authored_by: string;
  created_at: Date;
}

export interface FixtureMatch {
  row: Record<string, unknown>;
  /** Which card is down, if either. */
  withdrawn?: 'want' | 'have';
  /** When the withdrawn card came down. */
  withdrawnAgoDays?: number;
  offers?: FixtureOffer[];
  /** Messages waiting for Ana on this conversation. */
  waiting?: number;
  /** When each side's go-ahead window started, days ago. */
  windowAgoDays?: number;
  haveAttributes?: Record<string, unknown>;
  haveKind?: string;
}

export interface SweepWorld {
  matches: FixtureMatch[];
  arrangement: Record<string, unknown> | null;
  hearsVia: 'email' | 'assistant';
  timezone: string | null;
  locality: string;
  now: Date;
}

const base = (n: number, over: Record<string, unknown> = {}) => ({
  id: M(n),
  card_want: CW(n),
  card_have: CH(n),
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  kind: 'mountain bike',
  stage: 4,
  interest_want: true,
  interest_have: true,
  state: 'open',
  live: true,
  channel_id: `ch_${n}`,
  opened_at: new Date('2026-09-10T00:00:00Z'),
  created_at: new Date('2026-09-10T00:00:00Z'),
  my_optin: true,
  certainty: 'sure',
  ...over,
});

export function representativeWorld(now = new Date('2026-09-27T02:00:00Z')): SweepWorld {
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const bikeAttrs = {
    frame_size: 'medium',
    wheel_size: '29 inch',
    condition: 'used, good',
    brand: 'Giant',
    model: 'Talon 2',
    suspension: 'front',
    comes_with: 'pedals and a bottle cage',
  };
  return {
    arrangement: {
      runs_on_its_own: true,
      check_every_minutes: 60,
      interrupt_for: ['a figure on the table', 'a message from someone'],
      summarize: 'once in the evening',
      suggestion_appetite: 'occasional',
      quiet_hours: '10pm to 7am',
      notes: 'Prefers pickup on weekends.',
    },
    hearsVia: 'assistant',
    timezone: 'Australia/Perth',
    locality: 'Fremantle',
    now,
    matches: [
      // 1. A fresh maybe: details open, nobody has pressed.
      {
        row: base(1, {
          stage: 2,
          channel_id: null,
          opened_at: null,
          my_optin: false,
          certainty: 'possible',
          category: 'goods.bicycle.parts',
          kind: 'mountain bike wheelset',
        }),
        haveAttributes: { wheel_size: '27.5 inch', hub: 'Shimano', condition: 'used' },
        haveKind: 'road bike wheels',
      },
      // 2. Talking, a figure from them with a note, two messages waiting.
      {
        row: base(2, { category: 'goods.furniture.desk', kind: 'standing desk' }),
        offers: [
          {
            id: 'f0000002-0000-4000-8000-000000000001',
            match_id: M(2),
            proposer_account: BEPPE,
            amount: '180',
            ccy: 'AUD',
            state: 'proposed',
            message: { text: 'Can do Saturday morning if that suits.', provenance: 'counterparty-untrusted' },
            authored_by: 'human',
            created_at: ago(0.1),
          },
        ],
        waiting: 2,
        windowAgoDays: 1,
        haveAttributes: { width: '140 cm', motor: 'dual', condition: 'like new' },
        haveKind: 'electric standing desk',
      },
      // 3. Deal agreed, their posting taken down twelve days ago, all quiet.
      {
        row: base(3),
        withdrawn: 'have',
        withdrawnAgoDays: 12,
        offers: [
          {
            id: 'f0000003-0000-4000-8000-000000000001',
            match_id: M(3),
            proposer_account: ANA,
            amount: '415',
            ccy: 'AUD',
            state: 'accepted-by-human',
            message: null,
            authored_by: 'human',
            created_at: ago(13),
          },
        ],
        windowAgoDays: 14,
        haveAttributes: bikeAttrs,
        haveKind: 'mountain bike',
      },
      // 4. Their side taken down nine days ago, nothing on the table, quiet.
      {
        row: base(4, { category: 'goods.sports.climbing', kind: 'bouldering mat' }),
        withdrawn: 'have',
        withdrawnAgoDays: 9,
        windowAgoDays: 10,
        haveAttributes: { size: '100 x 120 cm', condition: 'used', fold: 'taco' },
        haveKind: 'bouldering crash pad',
      },
      // 5. Their side taken down yesterday: not quiet yet, carried in full.
      {
        row: base(5, { category: 'goods.electronics.camera', kind: 'mirrorless camera' }),
        withdrawn: 'have',
        withdrawnAgoDays: 1,
        windowAgoDays: 3,
        haveAttributes: { brand: 'Fujifilm', model: 'X-T3', lens: '18-55', condition: 'good' },
        haveKind: 'mirrorless camera body and kit lens',
      },
      // 6. In line.
      { row: base(6, { live: false, stage: 2, channel_id: null }) },
      // 7. Filed away after names crossed.
      { row: base(7, { state: 'archived', stage: 4, archived_at: ago(20), archived_via: null }) },
      // 8. Declined.
      { row: base(8, { state: 'declined', stage: 2, channel_id: null }) },
    ],
  };
}

export const cryptoMock = async (orig: () => Promise<Record<string, unknown>>) => {
  const { vi } = await import('vitest');
  return {
    ...(await orig()),
    decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
      Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [
          k,
          v === null || v === undefined ? '' : v.toString('utf8').replace(/^enc:/, ''),
        ]),
      ),
    ),
    writeConsentEvent: vi.fn(async () => 'consent-events/x'),
    writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
  };
};

export const fixtureCfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

/** A pool that answers every read the sweep makes from the world above. */
export function fakeSweepPool(world: SweepWorld, unknown: string[] = []) {
  const byMatch = new Map(world.matches.map((f) => [f.row.id as string, f]));
  const byCard = new Map<string, { f: FixtureMatch; side: 'want' | 'have' }>();
  for (const f of world.matches) {
    byCard.set(f.row.card_want as string, { f, side: 'want' });
    byCard.set(f.row.card_have as string, { f, side: 'have' });
  }
  const byChannel = new Map(
    world.matches.filter((f) => f.row.channel_id).map((f) => [f.row.channel_id as string, f]),
  );
  const ago = (d: number) => new Date(world.now.getTime() - d * DAY);
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
      // The lean sweep's one read of when each quiet candidate last moved.
      if (/AS last_activity/.test(sql)) {
        return rows(
          (params[0] as string[]).map((mid) => {
            const f = byMatch.get(mid);
            const times = [
              f?.withdrawn ? ago(f.withdrawnAgoDays ?? 0) : undefined,
              f?.windowAgoDays !== undefined ? ago(f.windowAgoDays) : undefined,
              ...(f?.offers ?? []).map((o) => o.created_at),
              f?.row.opened_at as Date | undefined,
            ].filter((t): t is Date => t instanceof Date);
            const last = times.length ? new Date(Math.max(...times.map((t) => +t))) : null;
            return { id: mid, last_activity: last };
          }),
        );
      }
      if (/^\s*SELECT m\.\*[^;]*FROM matches m/.test(sql)) {
        let list = world.matches.map((f) => f.row);
        const introFilter = /m\.id = \$(\d)/.exec(sql);
        if (introFilter) list = list.filter((r) => r.id === params[Number(introFilter[1]) - 1]);
        return rows(list);
      }
      if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) {
        const f = byMatch.get(params[0]);
        return rows(f ? [f.row] : []);
      }
      if (/count\(\*\)::int AS n FROM matches m/.test(sql)) return rows([{ n: 0 }]);
      if (/free|slots/i.test(sql) && /FROM cards/.test(sql)) return rows([{ slots: 1, used: 0, n: 0 }]);
      if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
        const c = byCard.get(params[0]);
        if (!c) return rows([]);
        const down = c.f.withdrawn === c.side;
        return rows([
          asScreened({
            id: params[0],
            account_id: c.side === 'want' ? ANA : BEPPE,
            type: c.side === 'want' ? 'WANT' : 'HAVE',
            category: c.f.row.category,
            kind: c.side === 'want' ? c.f.row.kind : (c.f.haveKind ?? c.f.row.kind),
            also_called: [],
            not_these: [],
            attributes: c.side === 'want' ? { condition: 'any' } : (c.f.haveAttributes ?? {}),
            ask: null,
            lifecycle_state: down ? 'WITHDRAWN' : 'PUBLISHED',
            updated_at: down ? ago(c.f.withdrawnAgoDays ?? 0) : ago(15),
            expires_at: new Date(world.now.getTime() + 30 * DAY),
          }),
        ]);
      }
      if (/SELECT amount, ccy, message FROM offers/.test(sql)) {
        const f = byMatch.get(params[0]);
        const live = (f?.offers ?? [])
          .filter((o) => o.proposer_account !== params[1] && ['proposed', 'awaiting-human'].includes(o.state))
          .sort((a, b) => +b.created_at - +a.created_at);
        return rows(live.slice(0, 1));
      }
      if (/SELECT id, proposer_account, amount, ccy, state, message, authored_by/.test(sql)) {
        const f = byMatch.get(params[0]);
        return rows(
          (f?.offers ?? [])
            .filter((o) => ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state))
            .sort((a, b) => +b.created_at - +a.created_at),
        );
      }
      if (/count\(DISTINCT account_id\)/.test(sql)) {
        const f = byMatch.get(params[0]);
        const both = f && Number(f.row.stage) >= 3;
        return rows([{ n: both ? 2 : 0, mine: both ? 1 : 0 }]);
      }
      if (/max\(recorded_at\) AS at FROM consent_tokens/.test(sql)) {
        return rows([{ at: new Date('2026-09-10T00:00:00Z') }]);
      }
      if (/FROM channel_messages/.test(sql) && /GROUP BY channel_id/.test(sql)) {
        const ids: string[] = params[1] ?? [];
        return rows(
          ids
            .map((c) => ({ channel_id: c, n: byChannel.get(c)?.waiting ?? 0 }))
            .filter((r) => r.n > 0),
        );
      }
      if (/FROM conversation_windows/.test(sql)) {
        const f = byMatch.get(params[0]);
        const d = f?.windowAgoDays ?? 0;
        return rows([
          {
            messages_sent: 4,
            in_time: d < 7,
            started_at: ago(d),
          },
        ]);
      }
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: world.hearsVia }]);
      if (/SELECT timezone FROM accounts/.test(sql)) return rows([{ timezone: world.timezone }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: world.arrangement }]);
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            status: 'active',
            data_key_enc: Buffer.from('wrapped'),
            first_name_enc: Buffer.from(params[0] === ANA ? 'enc:Ana' : 'enc:Beppe'),
            locality_enc: Buffer.from(`enc:${params[0] === ANA ? world.locality : 'Trastevere'}`),
          },
        ]);
      }
      if (/read_calls|write_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      unknown.push(sql.replace(/\s+/g, ' ').slice(0, 160));
      return rows([]);
    },
  } as any;
}
