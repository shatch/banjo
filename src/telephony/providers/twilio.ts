import { EventEmitter } from 'node:events';
import twilioLib from 'twilio';
import type WebSocket from 'ws';
import { config } from '../../config/index.js';
import { childLogger } from '../../lib/logger.js';
import { pcm16ToMuLaw } from '../audio/codec.js';
import type { AudioChunk } from '../../voice/types.js';
import type { TelephonyEvent, TelephonyEventListener, TelephonyProvider } from './types.js';

const logger = childLogger({ component: 'telephony:twilio' });

/** Standard DTMF dual-tone frequency pairs (low, high), in Hz. */
const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
};

const DTMF_SAMPLE_RATE = 8000;
const DTMF_TONE_MS = 120;
const DTMF_GAP_MS = 80;

/** readyState numeric value for an open ws connection (avoids needing a value import of the WebSocket class under verbatimModuleSyntax). */
const WS_OPEN = 1;

/**
 * How long to wait, after registerInboundCall() seeds `calls`, for the
 * Media Stream to actually connect (the 'start' event) before assuming it
 * never will and cleaning up. Needed because nothing else removes an
 * inbound call's entry if the caller hangs up during ringback or the WS
 * upgrade never lands at all (bad PUBLIC_HOSTNAME, tunnel down) — without
 * this, isAnyCallActive() would latch to true for the rest of the
 * process's life. Twilio opens the Media Stream socket within a couple of
 * seconds of receiving the Connect/Stream TwiML for a call it has already
 * accepted (no caller-pickup wait, unlike outbound origination) — 30s is
 * generous headroom above that, not a tight bound.
 */
const INBOUND_STREAM_CONNECT_TIMEOUT_MS = 30_000;

interface TwilioCallState {
  ws: WebSocket | null;
  streamSid: string | null;
  providerCallId: string | null;
  toNumber: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate `durationMs` of DTMF tone-pair audio for `digit`, as PCM16LE @ 8kHz. */
function generateDtmfTonePcm16(digit: string, durationMs: number): Buffer {
  const freqPair = DTMF_FREQUENCIES[digit];
  if (!freqPair) throw new Error(`invalid DTMF digit: ${digit}`);
  const [f1, f2] = freqPair;
  const sampleCount = Math.round((durationMs / 1000) * DTMF_SAMPLE_RATE);
  const buf = Buffer.alloc(sampleCount * 2);
  // Headroom so the summed dual-tone sine doesn't clip int16 range.
  const amplitude = 0.25 * 32767;
  for (let i = 0; i < sampleCount; i++) {
    const t = i / DTMF_SAMPLE_RATE;
    const sample = amplitude * (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
  }
  return buf;
}

/** Generate `durationMs` of silence as PCM16LE @ 8kHz (used as the inter-digit gap). */
function generateSilencePcm16(durationMs: number): Buffer {
  const sampleCount = Math.round((durationMs / 1000) * DTMF_SAMPLE_RATE);
  return Buffer.alloc(sampleCount * 2); // zeroed buffer == silence
}

/**
 * Twilio telephony adapter: REST call origination via the `twilio` SDK, plus
 * the Media Streams WebSocket side for bidirectional audio once the call is
 * connected. The webhook routes that return buildTwiml()/buildInboundTwiml()'s
 * XML and the WS upgrade handlers that call handleMediaStreamConnection()/
 * handleInboundMediaStreamConnection() both live elsewhere (src/server.ts) —
 * this class only owns the provider-side logic.
 */
export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';
  readonly nativeAudioFormat = 'g711_ulaw_8k' as const;

  private readonly client = twilioLib(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  private readonly emitter = new EventEmitter();
  private readonly calls = new Map<string, TwilioCallState>();
  private readonly inboundRegistrationTimers = new Map<string, NodeJS.Timeout>();

  async originateCall(opts: {
    to: string;
    callId: string;
    answeringMachineDetection?: boolean;
  }): Promise<{ providerCallId: string }> {
    this.calls.set(opts.callId, { ws: null, streamSid: null, providerCallId: null, toNumber: opts.to });

    // CONFIRMED against Twilio's Answering Machine Detection docs (2026-08):
    // `machineDetection`/`asyncAmd`/`asyncAmdStatusCallback` below are the
    // twilio node SDK's correct camelCase mapping onto the REST API's
    // `MachineDetection`/`AsyncAmd`/`AsyncAmdStatusCallback` params.
    // `MachineDetection: 'Enable'` (vs. the alternative `DetectMessageEnd`)
    // is a deliberate choice — it returns a verdict faster, at the cost of
    // not distinguishing *how* a machine was detected (beep vs. silence vs.
    // timeout). Since nothing here currently branches on that distinction
    // (see handleAmdCallback below and CallSession's 'answering_machine_detected'
    // case — it's logged/persisted, not used to change model behavior), the
    // faster verdict is the better tradeoff. Under 'Enable', Twilio's
    // AnsweredBy is one of human/machine_start/fax/unknown — see
    // TelephonyEvent's 'answering_machine_detected' union in
    // providers/types.ts, which matches this exactly (previously didn't:
    // it listed a DetectMessageEnd-only value and was missing 'fax').
    const result = await this.client.calls.create({
      to: opts.to,
      from: config.TWILIO_PHONE_NUMBER as string,
      url: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/twiml?callId=${opts.callId}`,
      machineDetection: opts.answeringMachineDetection ? 'Enable' : undefined,
      asyncAmd: opts.answeringMachineDetection ? 'true' : undefined,
      asyncAmdStatusCallback: opts.answeringMachineDetection
        ? `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/amd-callback?callId=${opts.callId}`
        : undefined,
    });

    const state = this.calls.get(opts.callId);
    if (state) state.providerCallId = result.sid;

    return { providerCallId: result.sid };
  }

  /**
   * TwiML the webhook route (src/server.ts) should return for
   * `POST /telephony/twilio/twiml?callId=...` — connects the call to our
   * Media Streams WebSocket for the duration of the call.
   *
   * callId is passed via a <Parameter> child element, NOT a query string on
   * the `url` attribute — confirmed against a live call that connected with
   * an empty callId despite the URL carrying `?callId=...`: Twilio strips
   * query-string parameters from <Stream url="..."> before opening the
   * WebSocket. <Parameter> values instead arrive in the `start` event's
   * `start.customParameters` once the socket connects (see
   * handleMediaStreamConnection below). An inbound call doesn't need this —
   * see buildInboundTwiml() below, which uses Twilio's own CallSid instead.
   */
  buildTwiml(callId: string): string {
    const streamUrl = `wss://${config.PUBLIC_HOSTNAME}/telephony/twilio/stream`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}"><Parameter name="callId" value="${callId}" /></Stream></Connect></Response>`;
  }

  /**
   * TwiML for `POST /telephony/twilio/inbound` (src/server.ts) once the call
   * has been accepted (INBOUND_BOOKING_ENABLED and not already busy — see
   * isAnyCallActive() below). Simpler than buildTwiml(): no <Parameter> is
   * needed because an inbound call's callId IS Twilio's own CallSid
   * (registerInboundCall below seeds `calls` keyed by it directly — see
   * src/inbound/schema.ts's doc comment on why no second id is minted),
   * which the 'start' event's own `start.callSid` field already carries
   * without a custom parameter.
   */
  buildInboundTwiml(): string {
    const streamUrl = `wss://${config.PUBLIC_HOSTNAME}/telephony/twilio/inbound-stream`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}" /></Connect></Response>`;
  }

  /**
   * TwiML for `POST /telephony/twilio/inbound` when the call is declined —
   * either INBOUND_BOOKING_ENABLED is off, or ea is already on another call
   * (inbound or outbound; see isAnyCallActive()). <Reject> ends the call
   * immediately without ever answering it — no Media Stream is ever
   * connected, so no CallSession is ever constructed for a declined call.
   */
  buildDeclineTwiml(): string {
    return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>';
  }

  /**
   * Whether ea is currently on ANY call, inbound or outbound. `calls` (this
   * class's private Map) holds an entry for every live call from the moment
   * it's registered (originateCall for outbound, registerInboundCall for
   * inbound) until it ends, regardless of direction, so its size is exactly
   * the concurrency signal the design spec's "decline if busy" policy
   * needs. Used by `POST /telephony/twilio/inbound` (src/server.ts) to
   * decide whether to accept or reject a new inbound call — this repo does
   * not yet support real concurrent-call handling (see the design spec's
   * "Explicitly deferred" section), so declining is the whole mechanism,
   * not a fallback for something more sophisticated.
   */
  isAnyCallActive(): boolean {
    return this.calls.size > 0;
  }

  /**
   * Seeds `calls` for an inbound call the moment its webhook lands (src/
   * server.ts's `POST /telephony/twilio/inbound` route), keyed by Twilio's
   * own CallSid. Unlike outbound's originateCall, providerCallId is set
   * immediately here rather than left null until a REST response arrives —
   * for an inbound call we already know it: it's the same value as the map
   * key itself. Without this, hangUp() below would find no providerCallId
   * and no-op with a warning on every inbound call — the same class of bug
   * its own doc comment describes for a different code path.
   */
  registerInboundCall(callSid: string, from: string): void {
    this.calls.set(callSid, { ws: null, streamSid: null, providerCallId: callSid, toNumber: from });
    // .unref() so this timer never keeps the process (or a test run) alive
    // by itself — the server's own listening socket is what keeps a real
    // process running; this timer only needs to fire while something else
    // already is.
    this.inboundRegistrationTimers.set(
      callSid,
      setTimeout(() => {
        this.inboundRegistrationTimers.delete(callSid);
        if (this.calls.has(callSid)) {
          logger.warn({ callSid }, 'inbound call never connected a Media Stream within the timeout — unregistering');
          this.calls.delete(callSid);
        }
      }, INBOUND_STREAM_CONNECT_TIMEOUT_MS).unref(),
    );
  }

  /**
   * Rolls back registerInboundCall() when something between registration
   * and answering the webhook fails (e.g. the inbound_calls DB write) —
   * called instead of hangUp() because at this point we haven't returned
   * TwiML yet, so Twilio doesn't consider the call answered and there is
   * nothing to hang up via the REST API. Without this, a failed write
   * would leave the call permanently in `calls`, and isAnyCallActive()
   * would latch to true forever since no 'stop'/hangUp event will ever
   * arrive for a call whose Media Stream never connects.
   */
  unregisterInboundCall(callSid: string): void {
    this.clearInboundRegistrationTimeout(callSid);
    this.calls.delete(callSid);
  }

  private clearInboundRegistrationTimeout(callId: string): void {
    const timer = this.inboundRegistrationTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.inboundRegistrationTimers.delete(callId);
    }
  }

  /**
   * Called by the server's WS upgrade handler (src/server.ts) as soon as it
   * accepts a `/telephony/twilio/stream` connection — BEFORE we know which
   * call this socket belongs to. callId is only known once the `start`
   * event arrives, carrying it in `start.customParameters` (see
   * buildTwiml()'s comment on why it can't come from the URL). Every other
   * event type here is inherently per-socket, so callId is scoped to this
   * closure once discovered rather than threaded through as a param.
   *
   * Delegates to handleMediaStreamConnectionCommon() below, shared with
   * handleInboundMediaStreamConnection() — every line of media/stop/error
   * handling (including the load-bearing raw-mu-law-passthrough behavior,
   * see the 'media' case's comment inside that helper) is identical
   * regardless of call direction; only HOW callId is resolved from the
   * 'start' event differs between the two.
   */
  handleMediaStreamConnection(ws: WebSocket): void {
    this.handleMediaStreamConnectionCommon(ws, (start) => start?.customParameters?.callId ?? null);
  }

  /**
   * Inbound counterpart of handleMediaStreamConnection() above — identical
   * event handling, resolving callId from the 'start' event's own `callSid`
   * field instead of a custom parameter (see registerInboundCall and
   * buildInboundTwiml's doc comments for why no second id is minted for an
   * inbound call).
   */
  handleInboundMediaStreamConnection(ws: WebSocket): void {
    this.handleMediaStreamConnectionCommon(ws, (start) => start?.callSid ?? null);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMediaStreamConnectionCommon(ws: WebSocket, resolveCallId: (start: Record<string, any>) => string | null): void {
    let callId: string | null = null;

    ws.on('message', (raw: unknown) => {
      let text: string;
      try {
        text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw as Buffer[]).toString('utf8')
            : Buffer.from(raw as ArrayBuffer).toString('utf8');
      } catch (err) {
        logger.warn({ err, callId }, 'failed to stringify Twilio media-stream message');
        return;
      }

      let msg: Record<string, any>;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        logger.warn({ err, callId }, 'failed to parse Twilio media-stream message as JSON');
        return;
      }

      switch (msg.event) {
        case 'connected': {
          logger.debug({}, 'Twilio media stream socket connected');
          break;
        }
        case 'start': {
          callId = resolveCallId(msg.start ?? {});
          if (!callId) {
            logger.error({ start: msg.start }, 'Twilio media stream start event carried no resolvable callId — closing, cannot associate this socket with any call');
            ws.close();
            return;
          }
          this.clearInboundRegistrationTimeout(callId);

          const state: TwilioCallState = this.calls.get(callId) ?? {
            ws: null,
            streamSid: null,
            providerCallId: null,
            toNumber: '',
          };
          state.ws = ws;
          const streamSid: string | undefined = msg.start?.streamSid;
          const callSid: string | undefined = msg.start?.callSid;
          if (streamSid) state.streamSid = streamSid;
          if (callSid) state.providerCallId = callSid;
          this.calls.set(callId, state);

          const event: TelephonyEvent = {
            callId,
            type: 'connected',
            meta: { callId, providerCallId: callSid ?? callId, toNumber: state.toNumber },
          };
          this.emitter.emit('event', event);
          break;
        }
        case 'media': {
          // callId is only null before 'start' has arrived on this socket —
          // 'start' either sets it or closes the socket, so by the time a
          // 'media'/'stop' event reaches here it's always set. Guarding
          // (rather than asserting) both satisfies TS's control-flow
          // analysis across switch cases and is a safe no-op in practice.
          if (!callId) break;
          // Emit RAW mu-law bytes here, not pre-decoded PCM16 — this was a
          // real bug (caught from a live call: the model's server-side VAD
          // reacted to audio energy, pausing when the caller spoke, but
          // never produced a coherent transcript/response). session/
          // audioPipeline.ts's resolveAudioPipeline() passthrough mode
          // (used whenever the negotiated Voice AI format is g711_ulaw_8k,
          // e.g. OpenAI/ElevenLabs) assumes inbound AudioChunks are already
          // in Twilio's native mu-law wire format and does NOT decode them —
          // that's the whole point of the passthrough optimization. Decoding
          // to PCM16 here meant CallSession forwarded PCM16 bytes to
          // OpenAI's input_audio_buffer while the session was configured
          // for audio/pcmu (mu-law) input: same byte count interpreted as
          // the wrong codec, corrupting every inbound frame. sendAudio()
          // below already assumed chunk.data arrives pre-encoded as mu-law
          // for the same reason — this fix makes the inbound side consistent
          // with that. (Gemini, which always requires real PCM16 and can't
          // use the passthrough path, still gets correctly decoded — that
          // conversion happens in audioPipeline.ts's non-passthrough branch,
          // not here.) This applies identically to inbound calls — nothing
          // about which direction a call came from changes the wire format.
          const payload: string | undefined = msg.media?.payload;
          if (!payload) break;
          const muLawBytes = Buffer.from(payload, 'base64');
          const chunk: AudioChunk = { data: muLawBytes, sampleRate: 8000 };
          const event: TelephonyEvent = { callId, type: 'audio_chunk', chunk };
          this.emitter.emit('event', event);
          break;
        }
        case 'stop': {
          if (!callId) break;
          // Distinguishes "Twilio told us the call ended" from "ea told
          // Twilio to end the call" (logged separately in hangUp() below) —
          // both used to be indistinguishable after the fact from log
          // output alone, which made a real report of the call cutting off
          // unexpectedly impossible to root-cause without guessing.
          logger.info({ callId }, "Twilio Media Stream reported the call ended ('stop') — not something ea initiated");
          const event: TelephonyEvent = { callId, type: 'ended', reason: 'stop' };
          this.emitter.emit('event', event);
          this.clearInboundRegistrationTimeout(callId);
          this.calls.delete(callId);
          break;
        }
        default:
          logger.debug({ callId, event: msg.event }, 'unhandled Twilio media-stream event type');
      }
    });

    ws.on('close', () => {
      logger.debug({ callId }, 'Twilio media stream socket closed');
      // Normally 'stop' (handled above) already removed this callId from
      // `calls`, and the socket closing afterward is just Twilio tearing
      // down the connection — the has() guard makes this a no-op then. It
      // only does real work when the socket closes WITHOUT a prior 'stop'
      // (network drop, Twilio-side error): without this, that call's entry
      // would survive in `calls` forever with no other event ever able to
      // remove it, latching isAnyCallActive() to true for the rest of the
      // process's life. Emitting 'ended' here lets CallSession wind the
      // session down instead of hanging in 'active' state forever;
      // CallSession.end() is idempotent (src/session/callSession.ts:247),
      // so this is harmless even if 'stop' already handled this same call
      // moments earlier.
      if (!callId) return;
      this.clearInboundRegistrationTimeout(callId);
      if (this.calls.has(callId)) {
        this.calls.delete(callId);
        const event: TelephonyEvent = { callId, type: 'ended', reason: 'socket_closed' };
        this.emitter.emit('event', event);
      }
    });

    ws.on('error', (err: Error) => {
      // Unlike the message-handler cases above, this can fire before 'start'
      // ever arrives (e.g. an immediate connection failure) — callId may
      // still be null. Nothing can attribute the event to a session yet in
      // that case, so log and drop it rather than emit a placeholder callId.
      if (!callId) {
        logger.warn({ err }, 'Twilio media stream socket error before callId was known — dropping event');
        return;
      }
      const event: TelephonyEvent = { callId, type: 'error', error: err };
      this.emitter.emit('event', event);
    });
  }

  /**
   * Called by the server's `/telephony/twilio/amd-callback` route (see
   * src/server.ts's TwilioHttpHooks) once Twilio POSTs the AMD verdict for
   * a call originated with answeringMachineDetection. This is the piece
   * that was actually missing before: the route parsed AnsweredBy and
   * logged it, but had nothing to hand the result to — TwilioProvider never
   * implemented this method, so `telephony.handleAmdCallback?.(...)`
   * silently no-op'd every time (optional chaining on a method that never
   * existed), and CallSession's 'answering_machine_detected' case (and the
   * DB write in updateCallAttempt) never fired despite AMD being requested
   * on every call. `answeredBy` is loosely typed as `string` here (it's
   * parsed from an HTTP POST body) and narrowed against the known value set
   * before being turned into a typed TelephonyEvent — an unrecognized value
   * (a future Twilio addition, a malformed callback) falls back to
   * 'unknown' rather than emitting a value TelephonyEvent's consumers
   * don't expect. AMD is an outbound-only concept (never requested on an
   * inbound leg — there's no `machineDetection` option on
   * registerInboundCall), so this callback route is never invoked for an
   * inbound call.
   */
  handleAmdCallback(callId: string, answeredBy: string): void {
    const KNOWN_VALUES = new Set(['human', 'machine_start', 'fax', 'unknown']);
    const normalized = KNOWN_VALUES.has(answeredBy) ? (answeredBy as 'human' | 'machine_start' | 'fax' | 'unknown') : 'unknown';
    const event: TelephonyEvent = { callId, type: 'answering_machine_detected', answeredBy: normalized };
    this.emitter.emit('event', event);
  }

  sendAudio(callId: string, chunk: AudioChunk): void {
    const state = this.calls.get(callId);
    if (!state?.ws || !state.streamSid || state.ws.readyState !== WS_OPEN) {
      logger.warn({ callId }, 'sendAudio called with no open Media Stream connection');
      return;
    }

    // NOTE: src/voice/types.ts documents AudioChunk.data as canonical
    // PCM16LE, but Twilio's Media Streams wire format requires 8kHz µ-law.
    // Per this scaffold's intended pipeline, codec conversion (PCM16 ->
    // µ-law via telephony/audio/codec.ts, plus resampling if the voice
    // provider's output isn't already 8kHz) happens upstream in
    // session/callSession.ts before sendAudio() is invoked — so this
    // adapter treats chunk.data as already-encoded µ-law bytes and just
    // base64-frames it onto the wire, rather than converting again here. If
    // that upstream conversion is ever skipped, raw PCM16 bytes would get
    // shipped as if they were µ-law and playback would be garbled — worth
    // a runtime format assertion if this becomes a real bug source.
    const message = {
      event: 'media',
      streamSid: state.streamSid,
      media: { payload: chunk.data.toString('base64') },
    };
    state.ws.send(JSON.stringify(message));
  }

  async sendDigits(callId: string, digits: string): Promise<void> {
    const state = this.calls.get(callId);
    if (!state?.ws || !state.streamSid || state.ws.readyState !== WS_OPEN) {
      throw new Error(`sendDigits: no open Media Stream connection for callId=${callId}`);
    }

    // CONFIRMED against Twilio's Media Streams WebSocket Messages docs
    // (2026-08): a server can only ever send `media`/`mark`/`clear` message
    // types to Twilio over a bidirectional Media Stream. Twilio's `dtmf`
    // message type exists only in the OTHER direction (Twilio -> server,
    // for detecting the *caller's* keypresses) — there is no signaling-level
    // way for us to inject DTMF outbound. Synthesizing standard DTMF
    // tone-pair audio ourselves (generateDtmfTonePcm16 above) and pushing it
    // down the same outbound `media` path as sendAudio() — i.e. audio that
    // *sounds* like touch-tones to whatever IVR is listening — is therefore
    // not a workaround but the only mechanism Twilio actually offers here.
    const ws = state.ws;
    const streamSid = state.streamSid;
    for (const digit of digits) {
      const toneMuLaw = pcm16ToMuLaw(generateDtmfTonePcm16(digit, DTMF_TONE_MS));
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: toneMuLaw.toString('base64') } }));
      await sleep(DTMF_TONE_MS);

      const silenceMuLaw = pcm16ToMuLaw(generateSilencePcm16(DTMF_GAP_MS));
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: silenceMuLaw.toString('base64') } }));
      await sleep(DTMF_GAP_MS);
    }
  }

  interrupt(callId: string): void {
    const state = this.calls.get(callId);
    if (!state?.ws || !state.streamSid || state.ws.readyState !== WS_OPEN) return;

    // Confirmed: Twilio Media Streams supports a `clear` control message
    // that flushes any outbound audio Twilio has buffered but not yet
    // played to the caller — the standard mechanism for barge-in.
    state.ws.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
  }

  async hangUp(callId: string): Promise<void> {
    const state = this.calls.get(callId);
    if (!state?.providerCallId) {
      logger.warn({ callId }, 'hangUp called with no known providerCallId — call may not have connected yet');
      return;
    }
    // finally, not a plain call: if Twilio's REST update rejects (e.g. the
    // call already ended on their side), the entry must still be freed —
    // otherwise it lingers in `calls` forever and isAnyCallActive() latches
    // to true for the rest of the process's life.
    logger.info({ callId, providerCallId: state.providerCallId }, 'ea is ending this call via the Twilio REST API');
    try {
      await this.client.calls(state.providerCallId).update({ status: 'completed' });
    } finally {
      this.clearInboundRegistrationTimeout(callId);
      this.calls.delete(callId);
    }
  }

  on(event: 'event', listener: TelephonyEventListener): void {
    this.emitter.on(event, listener);
  }

  off(event: 'event', listener: TelephonyEventListener): void {
    this.emitter.off(event, listener);
  }
}
