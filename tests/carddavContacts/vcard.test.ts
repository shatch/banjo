import { describe, expect, it } from 'vitest';
import { parseCard } from '../../src/carddavContacts/vcard.js';

const card = (lines: string[]) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n');

describe('parseCard', () => {
  it('reads name, UID, email, and phone numbers with their types', () => {
    const parsed = parseCard(
      card([
        'UID:urn:uuid:ABC-123',
        'FN:Claudia Groomer',
        'EMAIL;TYPE=INTERNET:claudia@example.com',
        'TEL;TYPE=CELL,VOICE:(555) 123-4567',
        'TEL;WORK:555.987.6543', // vCard 3.0 bare type
        'TEL;VALUE=uri:tel:+1-555-000-1111', // vCard 4.0 URI form
      ]),
    );
    expect(parsed).toMatchObject({
      uid: 'ABC-123',
      kind: 'individual',
      displayName: 'Claudia Groomer',
      email: 'claudia@example.com',
      phones: [{ value: '(555) 123-4567', type: 'mobile' }, { value: '555.987.6543', type: 'work' }, { value: '+1-555-000-1111' }],
    });
  });

  it('builds a display name from N, then ORG, when FN is empty', () => {
    expect(parseCard(card(['UID:1', 'FN:', 'N:Doe;Jane;;;']))?.displayName).toBe('Jane Doe');
    expect(parseCard(card(['UID:1', 'ORG:Luigi\\, Inc.;Front desk']))?.displayName).toBe('Luigi, Inc.');
  });

  it("reads Apple's item-grouped labels for phones and related names", () => {
    const parsed = parseCard(
      card([
        'UID:1',
        'FN:Pat',
        'item1.TEL:555-222-3333',
        'item1.X-ABLabel:_$!<Mobile>!$_',
        'item2.X-ABRELATEDNAMES:Sam',
        'item2.X-ABLabel:_$!<Spouse>!$_',
        'ITEM3.X-ABRELATEDNAMES:Alex',
        'item3.X-ABLabel:godparent',
      ]),
    );
    expect(parsed?.phones).toEqual([{ value: '555-222-3333', type: 'mobile' }]);
    expect(parsed?.relationLabels).toEqual(['spouse', 'godparent']);
  });

  it('reads vCard 4 RELATED types and CATEGORIES, keeping an escaped comma inside a name', () => {
    const parsed = parseCard(card(['UID:1', 'FN:Pat', 'RELATED;TYPE=child:urn:uuid:kid', 'CATEGORIES:Family,Friends\\, close']));
    expect(parsed?.relationLabels).toEqual(['child']);
    expect(parsed?.categories).toEqual(['Family', 'Friends, close']);
  });

  it('recognizes group cards in both the vCard 4 and Apple forms', () => {
    const v4 = parseCard(card(['UID:g1', 'KIND:group', 'FN:Family', 'MEMBER:urn:uuid:a', 'MEMBER:urn:uuid:b']));
    expect(v4).toMatchObject({ kind: 'group', displayName: 'Family', memberUids: ['a', 'b'] });

    const apple = parseCard(card(['UID:g2', 'X-ADDRESSBOOKSERVER-KIND:group', 'FN:Friends', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:c']));
    expect(apple).toMatchObject({ kind: 'group', displayName: 'Friends', memberUids: ['c'] });
  });

  it('unfolds continuation lines', () => {
    expect(parseCard(card(['UID:1', 'FN:Very Long', '  Name']))?.displayName).toBe('Very Long Name');
  });
});
