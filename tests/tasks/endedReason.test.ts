import { describe, expect, it } from 'vitest';
import { endedEarlyReason } from '../../src/tasks/endedReason.js';

describe('endedEarlyReason (#251)', () => {
  it("says in plain words that the line ended, instead of Twilio's raw 'stop'", () => {
    expect(endedEarlyReason('stop', 'disclosed', 3)).toBe(
      'The line ended before Banjo finished the call: the other party hung up, or the connection dropped. ' +
        'They had replied 3 times, but nothing was confirmed before the line ended. (Line event: stop.)',
    );
  });

  it('says how far the call got', () => {
    expect(endedEarlyReason('socket_closed', 'no_speech', 0)).toContain('Banjo never spoke, so nothing was said to them.');
    expect(endedEarlyReason('stop', 'disclosed', 0)).toContain('Banjo spoke, but they said nothing after its first line.');
    expect(endedEarlyReason('stop', 'missed', 1)).toContain('They had replied 1 time,');
    expect(endedEarlyReason('stop', 'disclosed')).toBe(
      'The line ended before Banjo finished the call: the other party hung up, or the connection dropped. (Line event: stop.)',
    );
  });

  it('describes the voice AI connection closing', () => {
    expect(endedEarlyReason('ws closed (code 1006)', 'disclosed', 2)).toMatch(/^The connection to the voice AI closed before Banjo finished the call\./);
  });

  it('keeps a reason that is already a sentence', () => {
    const neverConnected = 'The line was busy, so the call never connected.';
    expect(endedEarlyReason(neverConnected, 'no_speech', 0)).toBe(neverConnected);
  });
});
