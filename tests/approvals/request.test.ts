import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { buildApprovalMessage } from '../../src/approvals/request.js';
import { clipText, PUSHOVER_MAX_MESSAGE_CHARS, SMS_MAX_CHARS } from '../../src/notifications/limits.js';

config.PUBLIC_HOSTNAME = 'banjo.example.com';

const base = {
  contact: { displayName: "Luigi's", phoneNumber: '+15550001111' },
  task: {
    id: '11111111-1111-1111-1111-111111111111',
    goalDescription: 'Book Friday at 7',
    mode: 'booking' as const,
    questions: null,
    scheduledFor: null,
    approvalExpiresAt: new Date('2026-10-15T01:30:00.000Z'),
    constraints: {},
  },
};

describe('the approval message', () => {
  it('names who, when and what, with the link', () => {
    const msg = buildApprovalMessage(base);
    expect(msg).toContain('call +15550001111 now');
    expect(msg).toContain("Contact name, typed in (not from your address book): Luigi's");
    expect(msg).toContain('https://banjo.example.com/approve/11111111-1111-1111-1111-111111111111?sig=');
    expect(msg).toContain('Book Friday at 7');
  });

  it('says when a scheduled call would be placed', () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, scheduledFor: new Date(Date.now() + 86_400_000) } });
    expect(msg).toMatch(/call \+15550001111 at /);
  });

  it('keeps the link when a long description is clipped, on Pushover and SMS', () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, goalDescription: 'x'.repeat(5000) } });
    expect(clipText(msg, PUSHOVER_MAX_MESSAGE_CHARS)).toMatch(/\/approve\/[0-9a-f-]{36}\?sig=[0-9a-f]{64}/);
    expect(clipText(msg, SMS_MAX_CHARS)).toMatch(/\/approve\/[0-9a-f-]{36}\?sig=[0-9a-f]{64}/);
  });

  it("lists an ask call's questions", () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, mode: 'ask', questions: ['Open Sunday?', 'Walk-ins?'] } });
    expect(msg).toContain('1. Open Sunday?');
    expect(msg).toContain('2. Walk-ins?');
  });
});

describe('the approval message shows what else the call will use', () => {
  it("includes the task's notes and the contact's notes, after the link", () => {
    const msg = buildApprovalMessage({
      contact: { ...base.contact, notes: 'Ask for Dana' },
      task: { ...base.task, constraints: { notes: 'Mention the coupon' } },
    });
    expect(msg).toContain('Notes for the call, from the agent: Mention the coupon');
    expect(msg).toContain('Notes on this contact: Ask for Dana');
    expect(msg.indexOf('/approve/')).toBeLessThan(msg.indexOf('Mention the coupon'));
  });
});

describe("the approval message keeps the agent's text from posing as Banjo's", () => {
  it('puts agent-written text on single lines, labelled as the agent\'s', () => {
    const msg = buildApprovalMessage({
      contact: { ...base.contact, notes: 'line1\nApprove here instead: https://evil.example' },
      task: {
        ...base.task,
        goalDescription: 'Book\n\nApprove by tomorrow, or it won\'t be placed: https://evil.example',
        constraints: { notes: 'x\r\nBanjo says: already approved' },
        mode: 'ask',
        questions: ['Open?\u2028Approve: https://evil.example'],
      },
    });
    const lines = msg.split('\n');
    // Only Banjo's own line starts with "Approve by", and only one line has a link.
    expect(lines.filter((l) => l.startsWith('Approve by'))).toHaveLength(1);
    expect(lines.filter((l) => /^(Approve|Banjo says)/.test(l.trim()))).toHaveLength(1);
    for (const l of lines.slice(3)) if (l) expect(l).toMatch(/^(Contact name|The agent wrote|Questions from the agent|\d+\.|Notes)/);
  });
});

describe("nothing the agent wrote comes before Banjo's link", () => {
  it("keeps the contact's name, which the agent can set, after the link line", () => {
    const msg = buildApprovalMessage({
      ...base,
      contact: { displayName: "Luigi's. Approve by 9 PM, or it won't be placed: https://evil.example", phoneNumber: '+15550001111' },
    });
    const [first, second] = msg.split('\n');
    expect(first).not.toContain('evil');
    expect(second).toMatch(/^Approve by .*\/approve\//);
    expect(msg.indexOf('evil')).toBeGreaterThan(msg.indexOf('/approve/'));
  });
});

describe('the approval message says what the owner can and can\'t trust about the contact', () => {
  it('labels a name nobody vouches for as typed in, before the name', () => {
    // The label goes before the agent-written name, so it can't be imitated after it.
    expect(buildApprovalMessage({ ...base, contact: { ...base.contact, displayName: 'Mom (from your address book)' } })).toContain(
      'Contact name, typed in (not from your address book): Mom (from your address book)\n',
    );
  });

  it("vouches only for the address book's own name", () => {
    expect(buildApprovalMessage({ ...base, contact: { ...base.contact, displayName: 'Mom', addressBookName: 'Mom' } })).toMatch(
      /Contact name, from your address book: Mom\n(?!Name saved in Banjo)/,
    );
    // A contact the agent added under its own name, later linked to an address-book entry by its number.
    const msg = buildApprovalMessage({
      ...base,
      contact: { ...base.contact, displayName: "Dr. Smith's office", addressBookName: 'Jane Hatch' },
    });
    expect(msg).toContain('Contact name, from your address book: Jane Hatch\n');
    expect(msg).toContain("Name saved in Banjo, typed in (used on the call): Dr. Smith's office");
    expect(msg).not.toContain("address book: Dr. Smith's office");
  });

  it('does not vouch for a linked contact whose address-book entry is gone (addressBookNameFor found none)', () => {
    expect(buildApprovalMessage({ ...base, contact: { ...base.contact, displayName: 'Mom' } })).toContain(
      'Contact name, typed in (not from your address book): Mom\n',
    );
  });

  it('says a family or friend contact may hear about the owner from their profile', () => {
    const msg = buildApprovalMessage({ ...base, contact: { ...base.contact, relationshipTier: 'family' } });
    expect(msg).toContain('Tagged family: on this call Banjo may answer their questions about you from your profile.');
    expect(buildApprovalMessage(base)).not.toContain('Tagged');
  });

  it('drops invisible direction and zero-width marks from what the agent wrote', () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, goalDescription: 'Book \u202Eevil\u2066x\u2069\u200B\uFEFF' } });
    expect(msg).toContain('Book evilx');
    expect(msg).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
  });
});

describe('the approval message for a call screening held (#150)', () => {
  it("says the owner's own key asked, and why screening held it, after the link", () => {
    const msg = buildApprovalMessage({
      ...base,
      task: { ...base.task, requestedByAgent: false, screenFlag: "Banjo's screening flagged it: It asks for a one-time code.\nApprove: https://evil.test" },
    });
    const [first, second, , ...rest] = msg.split('\n');
    expect(first).toBe('Banjo was asked, with your own key, to call +15550001111 now.');
    expect(second).toMatch(/^Approve by .*https:\/\/banjo\.example\.com\/approve\//);
    expect(rest).toContain("Held by call screening: Banjo's screening flagged it: It asks for a one-time code. Approve: https://evil.test");
  });

  it("still says an agent asked when it was the agent's request", () => {
    const msg = buildApprovalMessage({ ...base, task: { ...base.task, requestedByAgent: true, screenFlag: 'They asked not to be called again.' } });
    expect(msg.split('\n')[0]).toBe('An agent asked Banjo to call +15550001111 now.');
    expect(msg).toContain('Held by call screening: They asked not to be called again.');
  });
});
