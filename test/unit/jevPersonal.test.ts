import { describe, expect, it } from 'vitest';
import { jevPairState, withoutPersonalDetails } from '../../src/shadow/jevTrials.js';

// 27 September 2026: nothing that reaches or finds a person is sent to TypeSafe.
describe('what is sent to TypeSafe carries no personal details', () => {
  it('takes contact details and addresses out of free text', () => {
    const t = withoutPersonalDetails(
      'road bike, call 0412 345 678 or bob@example.com, pick up 12 Smith Street, see www.x.com @bobby',
    );
    expect(t).not.toMatch(/0412|example\.com|Smith Street|www\.|@bobby/);
    expect(t).toContain('road bike');
  });

  it('drops keys about people and places, and keeps what describes the thing', () => {
    const s = jevPairState(
      { category: 'goods.bicycle.road', kind: 'road bike', attributes: { frame_size: '56cm', contact_phone: '0412345678', suburb: 'Braddon', owner_name: 'Tony' } },
      { category: 'goods.bicycle.road', kind: 'Giant Contend 2', attributes: { brand: 'Giant', year: 2019, email: 'a@b.co' } },
    );
    expect(s.want.attributes).toEqual({ frame_size: '56cm' });
    expect(s.have.attributes).toEqual({ brand: 'Giant', year: 2019 });
  });

  it('leaves sizes, years and model numbers alone', () => {
    expect(withoutPersonalDetails('2019 Giant Contend 2, 56cm, 11-speed 105')).toBe('2019 Giant Contend 2, 56cm, 11-speed 105');
  });
});
