/**
 * Tracks the estimated wall-clock moment by which all audio sent so far to
 * the phone leg will have finished playing — used by hangUpAfterSpeaking
 * (voice/tools/callTools.ts) so a hang-up tool waits for trailing speech to
 * actually finish instead of sleeping a blind fixed duration. Pure and
 * isolated on purpose: no dependency on CallSession, WebSocket, or any
 * provider, so it's trivially testable with an injected clock.
 */
export interface AudioPlaybackTracker {
  /** Record that a chunk of this many bytes of 8kHz mu-law audio was just sent to the phone leg. */
  recordChunkSent(byteLength: number): void;
  /** The estimated wall-clock time (ms since epoch) by which everything sent so far will have finished playing. */
  estimatedDoneAt(): number;
  /** Clears the high-water mark — call this when buffered-but-unplayed audio is discarded (e.g. Twilio's `clear` on caller barge-in), so stale duration doesn't keep inflating estimatedDoneAt() for audio that will never actually play. */
  reset(): void;
}

/**
 * Keeps one number, a high-water mark of "playback done" time:
 * `highWaterMark = max(now(), highWaterMark) + byteLength / 8` (8kHz mu-law
 * is exactly 1 byte per sample, so `bytes / 8` is milliseconds of audio —
 * this is always the format actually sent to the phone leg by the time
 * CallSession forwards it, regardless of which voice AI vendor produced it;
 * see session/audioPipeline.ts's resolveAudioPipeline()). estimatedDoneAt()
 * re-clamps against `now()` on every read, so it self-corrects to real time
 * once playback catches up — it can never drift further into the future
 * than what's genuinely still unplayed.
 */
export function createAudioPlaybackTracker(now: () => number = Date.now): AudioPlaybackTracker {
  let highWaterMarkMs = 0;

  return {
    recordChunkSent(byteLength: number): void {
      highWaterMarkMs = Math.max(now(), highWaterMarkMs) + byteLength / 8;
    },
    estimatedDoneAt(): number {
      return Math.max(now(), highWaterMarkMs);
    },
    reset(): void {
      highWaterMarkMs = 0;
    },
  };
}
