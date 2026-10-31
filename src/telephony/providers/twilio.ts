import { EventEmitter } from 'node:events';
import twilioLib from 'twilio';
import type WebSocket from 'ws';
import { config } from '../../config/index.js';
import { childLogger } from '../../lib/logger.js';
import { pcm16ToMuLaw } from '../audio/codec.js';
import type { AudioChunk } from '../../voice/types.js';
import type { TransferResult } from '../../tasks/schema.js';
import type { LoopInResult, TelephonyEvent, TelephonyEventListener, TelephonyProvider } from './types.js';

const logger = childLogger({ component: 'telephony:twilio' });

/** How many ended call ids to remember for hangUp(); far above any concurrency Banjo runs at. */
const RECENTLY_ENDED_LIMIT = 500;

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
  recordingSid?: string; // set by startRecording, so transferCall can stop it (#7)
  // A start that failed after it was sent (#151): Twilio may still have begun
  // recording, and not list it yet. stopRecording then can't confirm a stop.
  recordingUncertain?: boolean;
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

/** Said to the principal when a transfer reaches them (#74), before they are connected. */
const TRANSFER_SCREEN_PROMPT = 'Your AI assistant is transferring a call to you. Press 1 to take it.';
/** The screen's prompt when the transferred part is recorded (TRANSCRIBE_TRANSFERS): pressing 1 accepts that too. */
const TRANSFER_SCREEN_PROMPT_RECORDED = 'Your AI assistant is transferring a call to you. This call is recorded. Press 1 to take it.';
/**
 * Played to the other party before a transfer rings the principal, when the
 * transferred part is recorded (TRANSCRIBE_TRANSFERS). Fixed audio, not the
 * model's words: the consent can't depend on what the model chose to say (#8).
 */
export const TRANSFER_RECORDING_NOTICE = 'This call will be recorded.';
/** Seconds the screen waits for a key after the prompt, per Twilio <Gather>. */
const TRANSFER_SCREEN_TIMEOUT_S = 5;
/** How long an accepted screen waits for its transfer callback (which comes when the bridged call ends) before it's swept: Twilio's default <Dial> timeLimit, 4 hours. */
const ACCEPTED_TRANSFER_TTL_MS = 4 * 60 * 60_000;

/** How long the owner's line rings on a warm transfer (#149) before Twilio gives up on it. */
const LOOP_IN_RING_TIMEOUT_S = 25;
/** Seconds each "press 1" prompt on the owner's leg waits for a key (#149). */
const LOOP_IN_KEY_TIMEOUT_S = 6;
/** Said to the owner first on a warm transfer (#149), ahead of Banjo's brief. */
const LOOP_IN_GREETING = 'Hi, this is your AI assistant, on a call for you.';
const LOOP_IN_PROMPT = "Press 1 to talk to them now. Or hang up, and I'll carry on without you.";

/**
 * A warm transfer in progress (#149), keyed by the call it belongs to.
 * `bridging` is set once the owner presses 1: from then on, nothing but the
 * bridge itself may settle it or hang up their leg.
 */
interface PendingLoopIn {
  ownerCallSid?: string;
  bridging: boolean;
  timer?: NodeJS.Timeout;
  settle: (result: LoopInResult) => void;
}

/**
 * The final CallStatus values handleStatusCallback acts on, and the reason each
 * one gives the task — the text the owner's notification shows. 'completed'
 * without a media stream means the call was answered but Banjo's audio never
 * connected (e.g. the TwiML fetch failed).
 */
const NEVER_CONNECTED_REASONS: Record<string, string> = {
  busy: 'The line was busy, so the call never connected.',
  'no-answer': 'Nobody answered; the call rang out without connecting.',
  failed: "The call couldn't be connected. Twilio reported it as failed; the number may not accept calls.",
  canceled: 'The call was canceled before it connected.',
  completed: "The call ended before Banjo's audio connected.",
};

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
  /**
   * Transfers whose principal pressed 1 at the screening prompt (#74), and
   * when, until the transfer callback takes the entry. Per process, like
   * `calls`: a restart between the press and the callback reports an
   * accepted transfer as no_answer, and the caller hears the fallback line
   * after the call. An entry whose callback never comes is swept after
   * ACCEPTED_TRANSFER_TTL_MS.
   */
  private readonly acceptedTransfers = new Map<string, number>();
  /** Warm transfers waiting on the owner (#149). Per process, like `calls`. */
  private readonly loopIns = new Map<string, PendingLoopIn>();
  /** Calls forgotten recently, so a repeat hangUp() isn't mistaken for an unknown call. Capped: oldest dropped first. */
  private readonly recentlyEnded = new Set<string>();
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
      // A call that never connects (busy, no answer, failed) never fetches the
      // TwiML or opens a media stream, so without this nothing reaches Banjo and
      // the task sat in 'calling' until the stale-call sweep (#79). 'completed'
      // is Twilio's terminal event and carries every final CallStatus.
      statusCallback: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/status-callback?callId=${opts.callId}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed'],
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
          this.forgetCall(callSid);
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
    this.forgetCall(callSid);
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
          // One call per socket: a second 'start' never re-points it.
          if (callId) break;
          const claimedCallId = resolveCallId(msg.start ?? {});
          if (!claimedCallId) {
            logger.error({ start: msg.start }, 'Twilio media stream start event carried no resolvable callId — closing, cannot associate this socket with any call');
            ws.close();
            return;
          }
          const streamSid: string | undefined = msg.start?.streamSid;
          const callSid: string | undefined = msg.start?.callSid;

          // A stream may only attach to a call Banjo placed or answered
          // (originateCall / registerInboundCall seed `calls`), only once, and
          // only with that call's own CallSid once Twilio has told us it. A
          // made-up id used to create an entry here — latching
          // isAnyCallActive(), so every inbound call was declined — and a
          // known one had its socket taken over. The upgrade's signature
          // check (src/server.ts) is the first gate; this one holds even with
          // TWILIO_WEBHOOK_VALIDATION_ENABLED off.
          const state = this.calls.get(claimedCallId);
          const refusal = !state
            ? 'no such call'
            : state.ws
              ? 'call already has a media stream'
              : state.providerCallId && state.providerCallId !== callSid
                ? 'callSid does not match the call'
                : null;
          if (!state || refusal) {
            logger.warn({ callId: claimedCallId, reason: refusal }, 'refusing a media stream start event — closing');
            ws.close();
            return;
          }
          callId = claimedCallId;
          this.clearInboundRegistrationTimeout(callId);

          state.ws = ws;
          if (streamSid) state.streamSid = streamSid;
          if (callSid) state.providerCallId = callSid;

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
          this.forgetCall(callId);
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
        this.forgetCall(callId);
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

  /**
   * Called by the server's `/telephony/twilio/status-callback` route with a
   * call's final CallStatus (#79). Only acts on a call that never opened its
   * media stream: once the stream is open, its 'stop' or socket close already
   * ends the call, and a 'completed' arriving after that finds the call
   * forgotten here and is ignored. A call this process doesn't know about
   * (e.g. placed before a restart) is left to the stale-call sweep.
   */
  handleStatusCallback(callId: string, callStatus: string): void {
    const state = this.calls.get(callId);
    if (!state || state.ws) return;
    const reason = NEVER_CONNECTED_REASONS[callStatus];
    if (!reason) return;
    logger.info({ callId, callStatus }, 'Twilio reported the call ended before its media stream connected');
    this.forgetCall(callId);
    const event: TelephonyEvent = { callId, type: 'ended', reason };
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

  /** The only way a call leaves `calls` — remembered in recentlyEnded (see hangUp). */
  private forgetCall(callId: string): void {
    this.calls.delete(callId);
    // The other party hung up while Banjo was reaching the owner (#149): stop
    // ringing them for a call that's gone. A bridge in progress forgets the
    // call itself and is left alone.
    if (!this.loopIns.get(callId)?.bridging) this.finishLoopIn(callId, 'no_answer', { hangUpOwner: true });
    this.recentlyEnded.add(callId);
    if (this.recentlyEnded.size > RECENTLY_ENDED_LIMIT) {
      const oldest = this.recentlyEnded.values().next().value;
      if (oldest !== undefined) this.recentlyEnded.delete(oldest);
    }
  }

  async hangUp(callId: string): Promise<void> {
    const state = this.calls.get(callId);
    if (!state?.providerCallId) {
      // A call this provider already ended: expected, not a problem.
      // CallSession's teardown hangs up after an ending tool already has, and
      // used to log this warning on every call.
      if (!state && this.recentlyEnded.has(callId)) {
        logger.debug({ callId }, 'hangUp: call already ended');
        return;
      }
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
      this.forgetCall(callId);
    }
  }

  /**
   * Cold transfer (#7). <Connect><Stream> is terminal TwiML, so a live call
   * can't <Dial> from inside itself: it's redirected over REST instead, the
   * same shape as hangUp(). Nothing follows the <Dial> — with an `action`,
   * Twilio runs the callback's TwiML instead (buildTransferCallbackTwiml).
   */
  async transferCall(callId: string, opts: { to: string }): Promise<void> {
    const state = this.calls.get(callId);
    if (!state?.providerCallId) throw new Error(`transferCall: no live Twilio call for ${callId}`);
    const call = this.client.calls(state.providerCallId);

    // The callee agreed to a recorded call with Banjo, not to recording the
    // principal's conversation once the call is bridged.
    if (state.recordingSid) {
      await call
        .recordings(state.recordingSid)
        .update({ status: 'stopped' })
        .catch((err: unknown) => logger.warn({ err, callId }, 'could not stop the recording before transfer — transferring anyway'));
    }

    const response = new twilioLib.twiml.VoiceResponse();
    // TRANSCRIBE_TRANSFERS: the other party hears the notice before anything is
    // recorded, and the principal's screen says it too. The recording, one
    // channel each, starts when the principal answers and is transcribed and
    // deleted once the call ends (transcripts/transferLeg.ts).
    if (config.TRANSCRIBE_TRANSFERS) response.say(TRANSFER_RECORDING_NOTICE);
    const dial = response.dial({
      timeout: 20,
      answerOnBridge: true,
      action: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/transfer-callback?callId=${encodeURIComponent(callId)}`,
      ...(config.TRANSCRIBE_TRANSFERS && {
        record: 'record-from-answer-dual' as const,
        recordingStatusCallback: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/transfer-recording?callId=${encodeURIComponent(callId)}`,
        recordingStatusCallbackEvent: ['completed' as const],
      }),
    });
    // #74: a carrier voicemail answers a dial just like a person, so the
    // principal's leg is screened first — see buildTransferScreenTwiml.
    dial.number({ url: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/transfer-screen?callId=${encodeURIComponent(callId)}` }, opts.to);

    // Deliberately no TwiML (it holds the principal's number) in this log line.
    logger.info({ callId, providerCallId: state.providerCallId }, 'transferring this call via the Twilio REST API');
    await call.update({ twiml: response.toString() });

    // Only after success, unlike hangUp()'s finally: a failed redirect leaves
    // a call Banjo still has to talk on, and the stream's 'stop'/close
    // handlers forget it whenever it really ends. Forgetting now also makes
    // CallSession's teardown hangUp() a no-op, where it would otherwise hang
    // up the bridged call if it ran before Twilio's 'stop' arrives.
    this.clearInboundRegistrationTimeout(callId);
    this.forgetCall(callId);
  }

  /**
   * Runs on the principal's leg once it picks up, before it is bridged (#74);
   * the caller keeps hearing ringing (answerOnBridge). Only a press of 1
   * bridges the call. Anything else, and silence, which is what a voicemail
   * greeting gives, hangs up the principal's leg, so the dial ends unanswered
   * and the caller hears TRANSFER_FALLBACK_MESSAGE.
   */
  buildTransferScreenTwiml(callId: string): string {
    const response = new twilioLib.twiml.VoiceResponse();
    const gather = response.gather({
      numDigits: 1,
      timeout: TRANSFER_SCREEN_TIMEOUT_S,
      action: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/transfer-screen-result?callId=${encodeURIComponent(callId)}`,
    });
    gather.say({ loop: 2 }, config.TRANSCRIBE_TRANSFERS ? TRANSFER_SCREEN_PROMPT_RECORDED : TRANSFER_SCREEN_PROMPT);
    response.hangup();
    return response.toString();
  }

  /** The principal's answer to the screening prompt (#74): a 1 bridges the call (once this response ends, so does the screen), anything else hangs up their leg. */
  acceptTransferScreen(callId: string, digits: string): string {
    const response = new twilioLib.twiml.VoiceResponse();
    if (digits === '1') {
      const now = Date.now();
      for (const [id, at] of this.acceptedTransfers) if (now - at > ACCEPTED_TRANSFER_TTL_MS) this.acceptedTransfers.delete(id);
      this.acceptedTransfers.set(callId, now);
      response.say('Connecting.');
    } else {
      response.hangup();
    }
    return response.toString();
  }

  /** Whether the principal accepted this transfer at the screen (#74). Reads it once. */
  takeTransferAccepted(callId: string): boolean {
    return this.acceptedTransfers.delete(callId);
  }

  /** The TwiML Twilio runs once a transfer's <Dial> ends (#7): hang up if the principal answered, else say the fallback line first. */
  buildTransferCallbackTwiml(result: TransferResult): string {
    const response = new twilioLib.twiml.VoiceResponse();
    if (result !== 'answered') response.say(config.TRANSFER_FALLBACK_MESSAGE);
    response.hangup();
    return response.toString();
  }

  /**
   * Warm transfer (#149). The other party stays on Banjo's media stream, so
   * Banjo is still with them, while a second call rings the owner and reads
   * them the brief (buildLoopInTwiml). Their key press arrives through
   * acceptLoopIn. Pressing 1 bridges both legs into a two-person conference,
   * and anything else settles this promise with the call still Banjo's. So
   * do the second call's end (handleLoopInStatus), the other party hanging
   * up (forgetCall), and `timeoutMs` passing.
   */
  async loopInOwner(callId: string, opts: { to: string; brief: string; timeoutMs: number }): Promise<LoopInResult> {
    if (!this.calls.get(callId)?.providerCallId) throw new Error(`loopInOwner: no live Twilio call for ${callId}`);
    if (this.loopIns.has(callId)) throw new Error(`loopInOwner: already reaching the owner for ${callId}`);
    let settle!: (result: LoopInResult) => void;
    const result = new Promise<LoopInResult>((resolve) => (settle = resolve));
    const pending: PendingLoopIn = { bridging: false, settle };
    this.loopIns.set(callId, pending);
    try {
      const ownerCall = await this.client.calls.create({
        to: opts.to,
        from: config.TWILIO_PHONE_NUMBER as string,
        twiml: this.buildLoopInTwiml(callId, opts.brief),
        timeout: LOOP_IN_RING_TIMEOUT_S,
        statusCallback: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/loop-in-status?callId=${encodeURIComponent(callId)}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['completed'],
      });
      pending.ownerCallSid = ownerCall.sid;
    } catch (err) {
      this.loopIns.delete(callId);
      throw err;
    }
    // Settled already: the other party hung up while the owner's call was being placed.
    if (this.loopIns.get(callId) !== pending) {
      if (pending.ownerCallSid) this.hangUpOwnerLeg(callId, pending.ownerCallSid);
      return result;
    }
    // No owner number or brief in the log: both are the principal's.
    logger.info({ callId, ownerCallSid: pending.ownerCallSid }, 'warm transfer: calling the owner on a second line');
    pending.timer = setTimeout(() => {
      if (!pending.bridging) this.finishLoopIn(callId, 'no_answer', { hangUpOwner: true });
    }, opts.timeoutMs);
    return result;
  }

  /**
   * The owner's leg (#149): the brief, then "press 1", asked twice. Silence,
   * which is what their voicemail gives, ends in a hang-up, and the call is
   * still Banjo's. The brief is Banjo's words about the call, read only to
   * the owner.
   */
  buildLoopInTwiml(callId: string, brief: string): string {
    const response = new twilioLib.twiml.VoiceResponse();
    const action = `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/loop-in-result?callId=${encodeURIComponent(callId)}`;
    const first = response.gather({ numDigits: 1, timeout: LOOP_IN_KEY_TIMEOUT_S, action });
    first.say(LOOP_IN_GREETING);
    first.say(brief);
    first.say(LOOP_IN_PROMPT);
    response.gather({ numDigits: 1, timeout: LOOP_IN_KEY_TIMEOUT_S, action }).say(LOOP_IN_PROMPT);
    response.hangup();
    return response.toString();
  }

  /**
   * The owner's key press on a warm transfer (#149), returning the TwiML for
   * their leg. On 1, the other party's call is redirected into a conference
   * and Banjo's stream with it, and the owner joins it. Either one leaving
   * ends it for both. A recording stops first, as on a cold transfer. Any
   * other key, or a 1 that comes too late, hangs up the owner's leg.
   */
  async acceptLoopIn(callId: string, digits: string): Promise<string> {
    const response = new twilioLib.twiml.VoiceResponse();
    const pending = this.loopIns.get(callId);
    if (!pending || pending.bridging) {
      response.say('Sorry, that call has already ended.');
      response.hangup();
      return response.toString();
    }
    if (digits !== '1') {
      this.finishLoopIn(callId, 'declined', { hangUpOwner: false });
      response.say("Okay, I'll carry on without you.");
      response.hangup();
      return response.toString();
    }
    pending.bridging = true;
    const state = this.calls.get(callId);
    const room = `banjo-${callId}`;
    try {
      if (!state?.providerCallId) throw new Error('the call has ended');
      const call = this.client.calls(state.providerCallId);
      if (state.recordingSid) {
        await call
          .recordings(state.recordingSid)
          .update({ status: 'stopped' })
          .catch((err: unknown) => logger.warn({ err, callId }, 'could not stop the recording before the warm transfer — bridging anyway'));
      }
      const theirs = new twilioLib.twiml.VoiceResponse();
      theirs.dial().conference({ beep: 'false', endConferenceOnExit: true, waitUrl: '' }, room);
      await call.update({ twiml: theirs.toString() });
    } catch (err) {
      logger.warn({ err, callId }, 'warm transfer: the owner accepted, but bridging failed — the call is still Banjo\'s');
      this.finishLoopIn(callId, 'no_answer', { hangUpOwner: false });
      response.say("Sorry, I couldn't connect you. I'll carry on without you.");
      response.hangup();
      return response.toString();
    }
    logger.info({ callId }, 'warm transfer: the owner accepted — bridging');
    // As after transferCall: the stream's 'stop' will follow, and CallSession's teardown hangUp() must not end the bridged call.
    this.clearInboundRegistrationTimeout(callId);
    this.forgetCall(callId);
    this.finishLoopIn(callId, 'accepted', { hangUpOwner: false });
    response.say('Connecting.');
    response.dial().conference({ beep: 'false', endConferenceOnExit: true, waitUrl: '' }, room);
    return response.toString();
  }

  /** The owner's leg ended (#149). Settles a warm transfer still waiting on them: busy, no answer, or they hung up without pressing a key. */
  handleLoopInStatus(callId: string, callStatus: string): void {
    const pending = this.loopIns.get(callId);
    if (!pending || pending.bridging) return;
    logger.info({ callId, callStatus }, 'warm transfer: the owner\'s line ended without accepting');
    this.finishLoopIn(callId, 'no_answer', { hangUpOwner: false });
  }

  private finishLoopIn(callId: string, result: LoopInResult, opts: { hangUpOwner: boolean }): void {
    const pending = this.loopIns.get(callId);
    if (!pending) return;
    this.loopIns.delete(callId);
    clearTimeout(pending.timer);
    if (opts.hangUpOwner && pending.ownerCallSid) this.hangUpOwnerLeg(callId, pending.ownerCallSid);
    pending.settle(result);
  }

  private hangUpOwnerLeg(callId: string, ownerCallSid: string): void {
    this.client
      .calls(ownerCallSid)
      .update({ status: 'completed' })
      .catch((err: unknown) => logger.warn({ err, callId }, "warm transfer: could not hang up the owner's line"));
  }

  /**
   * Two-track recording (callee and Banjo on separate channels) on the live
   * call, via the in-progress-call Recordings API — the method the demo
   * recordings used, starting ~0.13s after it's asked. Called by CallSession
   * only after Banjo has said the recording notice (#8).
   */
  async startRecording(callId: string): Promise<{ recordingId: string }> {
    const providerCallId = this.calls.get(callId)?.providerCallId;
    if (!providerCallId) throw new Error(`startRecording: no live Twilio call for ${callId}`);
    let recording: { sid: string };
    try {
      recording = await this.client.calls(providerCallId).recordings.create({ recordingChannels: 'dual', recordingTrack: 'both' });
    } catch (err) {
      const failed = this.calls.get(callId);
      if (failed) failed.recordingUncertain = true;
      throw err;
    }
    const state = this.calls.get(callId);
    if (state) state.recordingSid = recording.sid;
    logger.info({ callId, recordingId: recording.sid }, 'call recording started');
    return { recordingId: recording.sid };
  }

  /**
   * Stops every recording on the call for good (#151). It stops what Twilio
   * lists as running or paused, plus the recording this process started even
   * if the list doesn't show it (Twilio's lists can lag). Fails closed: throws
   * for a call it can't find, if Twilio can't be asked, or whenever a start
   * failed after it was sent: Twilio may have begun that recording without
   * listing it yet, so no list can confirm the stop. It still stops what it
   * finds first.
   */
  async stopRecording(callId: string): Promise<void> {
    const state = this.calls.get(callId);
    if (!state?.providerCallId) throw new Error(`stopRecording: no live Twilio call for ${callId}`);
    const call = this.client.calls(state.providerCallId);
    const listed = await call.recordings.list();
    const toStop = new Set(listed.filter((r) => r.status === 'in-progress' || r.status === 'paused').map((r) => r.sid));
    const known = state.recordingSid;
    if (known && !listed.some((r) => r.sid === known)) toStop.add(known);
    for (const sid of toStop) {
      await call.recordings(sid).update({ status: 'stopped' });
      logger.info({ callId, recordingId: sid }, 'call recording stopped');
    }
    if (state.recordingUncertain) {
      throw new Error(`stopRecording: a recording start on ${callId} failed after it was sent, so no stop can be confirmed`);
    }
  }

  /**
   * A finished recording's audio as WAV, two channels for a dual recording
   * (TRANSCRIBE_TRANSFERS). Fetched by its sid from the account's own API
   * path, never from a URL in a webhook body.
   */
  async fetchRecordingWav(recordingId: string): Promise<Buffer> {
    if (!/^RE[0-9a-f]{32}$/.test(recordingId)) throw new Error('fetchRecordingWav: not a recording sid');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Recordings/${recordingId}.wav?RequestedChannels=2`;
    const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`fetchRecordingWav: Twilio returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Deletes a recording from Twilio. Already gone (404) counts as deleted, so retention can't get stuck on one. */
  async deleteRecording(recordingId: string): Promise<void> {
    try {
      await this.client.recordings(recordingId).remove();
    } catch (err) {
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }

  on(event: 'event', listener: TelephonyEventListener): void {
    this.emitter.on(event, listener);
  }

  off(event: 'event', listener: TelephonyEventListener): void {
    this.emitter.off(event, listener);
  }
}
