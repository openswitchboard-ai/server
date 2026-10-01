/**
 * ADDRESSES AND PHONE NUMBERS STAY OUT OF THE WORDS (1 October 2026), and
 * nothing else does. The positives are the shapes people actually type; the
 * negatives are what two people arranging a handover say all day — times,
 * dates, prices, quantities, sizes, model numbers, a suburb on its own — and
 * every one of those must pass. Generic examples only.
 */
import { describe, expect, it } from 'vitest';
import { contactDetailRule } from '../../src/domain/contactInWords.js';

const PHONES = [
  'call me on 0412 345 678',
  'my mobile is 0412345678',
  'ring +61 412 345 678 after five',
  '+61412345678',
  'landline (02) 6123 4567',
  '02 6123 4567',
  'the shop is on 1300 123 456',
  '1800-123-456 is free to call',
  '+1 (555) 123-4567',
  '555-123-4567',
  '(555) 123-4567',
  '+44 20 7946 0958',
  '020 7946 0958',
  '+64 21 123 4567',
  'text zero four one two three four five six seven eight',
  'my number: 0412.345.678',
];

const ADDRESSES = [
  "I'm at 12 Smith St",
  'pick up from 14 smith street braddon',
  'Unit 3/45 Northbourne Avenue',
  '45a King William Road, Adelaide',
  'come to 7 Banksia Close.',
  'it is 22 Wattle Way',
  'post it to PO Box 123',
  '3-5 High St, Newtown',
  'meet at 101 Collins St Melbourne',
  '9 ocean pde',
  'address is 18 Acacia Court',
  '221b Baker Street',
];

const EMAILS = [
  'email me at sam.lee@example.com',
  'it is name+bike@example.co.uk',
  'reach me: jo_88@mail.example.org',
  'write to sam at example dot com',
  'sam (at) example (dot) net',
];

const PASSES = [
  // Emails' look-alikes (1 October 2026).
  'find me @samlee on there',
  'see you at 5pm',
  'it went for $40 @ the market',
  'the file is photo@2x.png',
  'icon@3x.webp attached',
  'meet at the station at noon',
  'Thursday around 7pm works',
  'I can do 7:30 on Saturday',
  'between 9 and 5 any weekday',
  'how about 2026-10-01?',
  'or 12/10/2026 if that suits',
  'the 2019 model with 2 batteries',
  'Trek 820, frame 54cm',
  'RTX 4090, barely used',
  'iPhone 13 128GB in blue',
  'size 10, fits true',
  '10-12 kg all up',
  'two 2 x 4 lengths',
  'meet at the station car park',
  'near the corner of Smith and Jones',
  'I live in Braddon ACT 2612',
  'postcode 2612',
  'I have 12 road bikes',
  'selling 2 old road bikes',
  'no way, 3 days is too long',
  '4 court shoes and 2 rackets',
  'order #12345678 arrived',
  'ABN 12 345 678 901',
  'it takes 3 to 5 days',
  'open 9-5, 7 days',
  'we can meet in 10 minutes',
  'I paid 1200 for it in 2021',
  'the 1300 series is older',
  'version 2.14.0 of the app',
  'score was 21-19, 21-17',
  'grab it from level 3',
  'I am 5 minutes away',
  'the 3 bedroom place is empty',
  'lap 2 of the 5 km loop is hilly',
  // Added with the review of 1 October 2026: street numbers against times,
  // quantities, postcodes, units, prices and dates.
  'meet at 10 on Smith St',
  'I can be there at 2 pm near High St',
  'it is 5 minutes from King St',
  'park 3 blocks off George St',
  'I am in unit 5',
  'unit 5, level 2',
  'Canberra 2600',
  'Newtown NSW 2042 is fine',
  '$12 each or 3 for $30',
  '2 for 1 on Main St today',
  'on 12 March at 10',
  'see you 10/10 at 6',
  'the 7.30 bus from Station St',
  '12:30 outside the Market St entrance',
  'we are about 3 streets over',
  '4 doors down from the bakery',
  'it has 2 ports and 1 cable',
  'we have 20 left, 5 in each box',
];

describe('contact details in the words', () => {
  for (const t of PHONES) {
    it(`finds a phone number: ${t}`, () => expect(contactDetailRule(t)).toBe('phone'));
  }
  for (const t of ADDRESSES) {
    it(`finds an address: ${t}`, () => expect(contactDetailRule(t)).toBe('address'));
  }
  for (const t of EMAILS) {
    it(`finds an email: ${t}`, () => expect(contactDetailRule(t)).toBe('email'));
  }
  for (const t of PASSES) {
    it(`lets ordinary words through: ${t}`, () => expect(contactDetailRule(t)).toBeUndefined());
  }
});
