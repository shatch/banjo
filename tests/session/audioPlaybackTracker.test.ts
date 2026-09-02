import { describe, expect, it } from 'vitest';
import { createAudioPlaybackTracker } from '../../src/session/audioPlaybackTracker.js';

describe('createAudioPlaybackTracker', () => {
  it('estimatedDoneAt() is "now" before any chunk has been recorded', () => {
    let currentTime = 1_000_000;
    const tracker = createAudioPlaybackTracker(() => currentTime);
    expect(tracker.estimatedDoneAt()).toBe(1_000_000);
  });

  it('advances the estimate by byteLength/8 ms per chunk (8kHz mu-law: 1 byte/sample)', () => {
    let currentTime = 1_000_000;
    const tracker = createAudioPlaybackTracker(() => currentTime);
    tracker.recordChunkSent(800); // 800 bytes / 8 = 100ms of audio
    expect(tracker.estimatedDoneAt()).toBe(1_000_100);
  });

  it('sequential chunks sent back-to-back stack their durations', () => {
    let currentTime = 1_000_000;
    const tracker = createAudioPlaybackTracker(() => currentTime);
    tracker.recordChunkSent(800); // +100ms -> 1_000_100
    tracker.recordChunkSent(1600); // +200ms -> 1_000_300
    expect(tracker.estimatedDoneAt()).toBe(1_000_300);
  });

  it('a gap longer than the buffered audio duration anchors the next estimate to "now" instead of drifting into the past', () => {
    let currentTime = 1_000_000;
    const tracker = createAudioPlaybackTracker(() => currentTime);
    tracker.recordChunkSent(800); // done at 1_000_100
    currentTime = 1_500_000; // huge gap — playback has long since caught up
    tracker.recordChunkSent(80); // 10ms of audio
    expect(tracker.estimatedDoneAt()).toBe(1_500_010); // anchored to the new "now", not 1_000_110
  });

  it('estimatedDoneAt() reflects elapsed real time even without a new chunk', () => {
    let currentTime = 1_000_000;
    const tracker = createAudioPlaybackTracker(() => currentTime);
    tracker.recordChunkSent(800); // done at 1_000_100
    currentTime = 1_000_050; // 50ms have passed, still mid-playback
    expect(tracker.estimatedDoneAt()).toBe(1_000_100); // unplayed remainder still in the future
    currentTime = 1_000_200; // playback has now finished
    expect(tracker.estimatedDoneAt()).toBe(1_000_200); // clamps to "now", not stuck in the past
  });

  it('reset() clears the high-water mark, returning estimatedDoneAt() to "now"', () => {
    // Regression coverage for caller barge-in: interrupt() flushes Twilio's
    // buffered-but-unplayed audio, but without reset() the tracker's
    // high-water mark would still count that discarded audio as "will
    // play," over-estimating for the rest of the call.
    let currentTime = 1_000_000;
    const tracker = createAudioPlaybackTracker(() => currentTime);
    tracker.recordChunkSent(80_000); // 10s of buffered audio, done at 1_010_000
    expect(tracker.estimatedDoneAt()).toBe(1_010_000);

    tracker.reset();
    expect(tracker.estimatedDoneAt()).toBe(1_000_000); // back to "now", not the stale 1_010_000

    currentTime = 1_000_500;
    expect(tracker.estimatedDoneAt()).toBe(1_000_500); // still tracks "now" correctly after reset
  });
});
