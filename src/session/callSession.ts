import { config, RECORDING_NOTICE } from '../config/index.js';
import { logger } from '../lib/logger.js';
import type { TelephonyEvent, TelephonyProvider } from '../telephony/providers/types.js';
import { createVoiceAIProvider } from '../voice/factory.js';
import { toToolDefinition, type VoiceTool } from '../voice/tools/defineVoiceTool.js';
import type { ToolDefinition } from '../voice/types.js';
import type { VerbatimDeliveryReport, VoiceAIEvent, VoiceAIProvider } from '../voice/types.js';
import { createAudioPlaybackTracker, type AudioPlaybackTracker } from './audioPlaybackTracker.js';
import { negotiateAudioFormats, resolveAudioPipeline, type AudioPipeline } from './audioPipeline.js';
import type { CallContext } from './types.js';
import { checkDisclosure, type DisclosureResult } from './disclosure.js';
import { classifyTranscript } from './transcriptQuality.js';

export type CallSessionState = 'connecting' | 'active' | 'tool-pending' | 'ending' | 'ended' | 'error';

// Firing the greeting the instant the Media Stream connects felt abrupt on a
// live call — almost no gap between "call picked up" and ea already talking.
const GREETING_DELAY_MS = 500;

// Slack after the recording notice's audio is estimated to have finished
// playing before recording starts (#8) — the playback estimate is not exact,
// and starting early is the one thing this must not do.
const RECORDING_START_MARGIN_MS = 500;

// Bounds how long a tool marked endsCall waits for the current response's
// 'turn_end' signal before snapshotting the audio-playback estimate (see
// handleToolCall). Comfortably covers a long trailing confirmation
// sentence's remaining generation/transmission time while leaving headroom
// under the 15s tool-pending watchdog even stacked with a slow tool handler.
const TURN_END_WAIT_MS = 4000;

// Bounds how long CallSession waits for a tool's verbatimMessage (see
// VoiceTool's doc comment) to finish being spoken via VoiceAIProvider.sayVerbatim
// before giving up and proceeding anyway — a missing/late turn_end signal
// shouldn't hang a hang-up tool forever, mirroring TURN_END_WAIT_MS's
// rationale above. Sized generously relative to TURN_END_WAIT_MS because,
// unlike a short trailing confirmation sentence, this covers reading an
// entire voicemail message aloud from scratch.
const SPEAK_VERBATIM_TIMEOUT_MS = 20_000;

// toolPendingWatchdog's normal budget (below) comfortably covers a fast tool
// handler, but a tool with verbatimMessage additionally waits through (in
// sequence) the pre-existing TURN_END_WAIT_MS, then up to
// SPEAK_VERBATIM_TIMEOUT_MS for the forced speech itself, then the handler's
// own hangUpAfterSpeaking wait (up to MAX_HANGUP_WAIT_MS in
// voice/tools/callTools.ts, currently 6000ms) — comfortably exceeding the
// normal 15s budget. Re-armed with this larger budget specifically for those
// tools (see handleToolCall) rather than raising the default for every tool.
const VERBATIM_TOOL_PENDING_BUDGET_MS = 35_000;

// Caught on a live call: after a finalized user transcript, OpenAI's
// Realtime API — which we rely on to auto-trigger a response via its own
// server-side VAD — never emitted another response event of any kind (no
// audio, no transcript, no error) for the rest of the call, even though the
// caller kept talking and being transcribed correctly throughout. Nothing on
// our side noticed; the call just sat silent until the caller gave up.
// SILENCE_WATCHDOG_MS bounds how long we wait after a user turn for the
// model to start responding before nudging it with an explicit
// triggerResponse() (same mechanism used for the greeting); a second
// unanswered window after that nudge gives up and fails the call, mirroring
// toolPendingWatchdog's "don't hang forever" philosophy for a stuck tool.
const SILENCE_WATCHDOG_MS = 7000;

// The session-level tool-pending watchdog for an ordinary tool call (see
// handleToolCall) — also that tool's budget when the call ends around it.
const TOOL_PENDING_WATCHDOG_MS = 15_000;

// Beyond a running tool's own budget, how long end()/fail() keep waiting for
// it (see waitForInFlightToolHandlers) — covers its DB write after its
// bounded work returns.
const IN_FLIGHT_TOOL_WAIT_MARGIN_MS = 1000;

type AnsweredBy = Extract<TelephonyEvent, { type: 'answering_machine_detected' }>['answeredBy'];

/**
 * Every persistence-triggering moment CallSession itself reaches, expressed
 * as data rather than a direct DB call — what each patch actually DOES
 * (write a CallAttempt row today; something else for an inbound call
 * tomorrow) is entirely up to whichever CallSessionOptions.onStatusChange
 * implementation is supplied.
 */
export type CallSessionStatusPatch =
  | { kind: 'started'; providerCallId: string }
  | { kind: 'answering_machine_detected'; answeredBy: AnsweredBy }
  | { kind: 'ended'; reason: string; disclosure: DisclosureResult }
  | { kind: 'failed'; reason: string; disclosure: DisclosureResult }
  | { kind: 'recording_started'; recordingId: string };

/**
 * Generic over the shape of context passed to this call's tool handlers
 * (TCtx) — outbound uses CallContext (task/callAttempt/contact-shaped);
 * a future inbound flow will use its own context shape. Everything else
 * about a live call (audio pipeline, tool-calling loop, hangup grace
 * period, watchdog) is identical regardless of direction, which is the
 * whole reason this is a persistence *seam* rather than a forked class —
 * see docs/superpowers/specs/2026-08-07-inbound-voice-booking-design.md's
 * "Architecture" section for the full rationale.
 */
export interface CallSessionOptions<TCtx = CallContext> {
  /** OUR internal call identity — what every TelephonyProvider method is keyed by, and what TelephonyEvent.callId is compared against. */
  callId: string;
  telephony: TelephonyProvider;
  systemPrompt: string;
  /** Voice-layer-only prompt, passed through as VoiceAISessionConfig.frontendInstructions — used only by a provider that splits its voice front-end from a reasoning backend (openai-live), which then gets `systemPrompt` as the backend prompt. Ignored by every other provider. */
  frontendSystemPrompt?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: VoiceTool<any, TCtx>[];
  /**
   * Record this call (#8). Recording starts only once Banjo has said the
   * recording notice (RECORDING_NOTICE) — disclosure is a prompt rule, so
   * this is what guarantees nothing is recorded before the other party is
   * told. The other party's greeting and Banjo's opener aren't on it.
   */
  recordCalls?: boolean;
  /** Whether CallSession should prompt the model to speak first once the call connects, before any caller input. Inbound: true. Outbound: unset/false — the callee naturally speaks first. */
  greetOnConnect?: boolean;
  /** Originates the call (outbound) or resolves the already-connected call's identity (inbound). */
  beginCall(): Promise<{ providerCallId: string }>;
  /** Built fresh on every tool invocation so handlers see current state, not a snapshot taken at session construction. `estimatedAudioDoneAt` is audioPlaybackTracker.estimatedDoneAt() at the moment of this call — see hangUpAfterSpeaking (voice/tools/callTools.ts) for why a hang-up tool needs it. `verbatimDelivery` is VoiceAIProvider.verbatimDeliveryReport()'s result after a tool's forced verbatim speech — undefined for a tool without verbatimMessage, or a provider that doesn't report. */
  buildToolContext(estimatedAudioDoneAt: number, verbatimDelivery?: VerbatimDeliveryReport): Promise<TCtx>;
  onStatusChange(patch: CallSessionStatusPatch): Promise<void>;
  /** Called after the legs are torn down (voice AI disconnected, telephony hung up) — separate from onStatusChange since a failure may need materially different persistence than a normal status update. */
  onFailure(reason: string): Promise<void>;
  /** Fires any final-outcome notification (e.g. SMS) once the call is in a terminal state — a no-op if it isn't. */
  notifyIfTerminal(): Promise<void>;
  /**
   * Every finalised, non-empty line, numbered in arrival order (#6). Its own
   * hook rather than onStatusChange/transitionTask: that path refuses writes
   * once a task is terminal, which would drop exactly the transcripts most
   * worth having. Called fire-and-forget — a rejection is logged, never
   * awaited by the call.
   */
  onTranscript(turn: TranscriptTurn): Promise<void>;
}

export interface TranscriptTurn {
  /** From 1, per call, across both sides, in the order lines went final. */
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  quality: 'ok' | 'suspect';
  voiceProvider: string;
  /** When CallSession received the final line — the events carry no timestamp of their own. */
  spokenAt: Date;
}

/**
 * The only component that touches both a TelephonyProvider and a
 * VoiceAIProvider at once — neither provider layer is aware the other
 * exists. One instance per live call attempt.
 */
export class CallSession<TCtx = CallContext> {
  private state: CallSessionState = 'connecting';
  private readonly voiceAI: VoiceAIProvider;
  /** Last seq handed to onTranscript (#6). */
  private transcriptSeq = 0;
  /** The first thing Banjo said — what the disclosure check (#8) judges. */
  private firstAssistantLine: string | undefined;
  /**
   * idle → (notice in Banjo's final line) awaiting_turn_end → (turn_end)
   * scheduled → started. An interruption before turn_end drops back to idle:
   * the notice's audio may have been cut off before it was heard.
   */
  private recordingState: 'idle' | 'awaiting_turn_end' | 'scheduled' = 'idle';
  private recordingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pipeline: AudioPipeline;
  private readonly outputFormat;
  private readonly toolRegistry: Map<string, VoiceTool<any, TCtx>>;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly audioPlaybackTracker: AudioPlaybackTracker;
  private providerCallId: string | null = null;
  private toolPendingWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** The tool call whose budget toolPendingWatchdog is timing; only it may clear the watchdog. */
  private toolPendingWatchdogOwner: string | null = null;
  private turnEndWaiters: Array<() => void> = [];
  private silenceWatchdog: ReturnType<typeof setTimeout> | null = null;
  private silenceNudgeSent = false;
  // Tracks whether a response is currently believed to be in flight — set
  // true whenever we ourselves call triggerResponse(), or when a tool_call/
  // audio_chunk shows the model has started responding by any means; cleared
  // on turn_end. Exists so the silence watchdog's nudge doesn't send a second
  // triggerResponse() while one it already sent (e.g. the opening greeting)
  // is still awaiting turn_end — sending two collides on the Voice AI side
  // ("already has an active response").
  private responseActive = false;
  /** Running tool handlers, each with the time its budget runs out (see toolBudgetMs). */
  private readonly inFlightToolHandlers = new Map<Promise<void>, number>();
  /**
   * The id of a running tool marked endsCall, or null. While set, no other
   * tool call is accepted and the silence watchdog neither arms nor nudges:
   * transfer_to_owner can wait over a minute on Twilio's redirect, and a
   * nudged end_call accepted meanwhile could hang up mid-transfer (#7).
   * Cleared when that handler finishes, so a failed transfer (the call still
   * Banjo's) goes back to normal.
   */
  private callEndingToolCallId: string | null = null;

  constructor(private readonly opts: CallSessionOptions<TCtx>) {
    this.voiceAI = createVoiceAIProvider();
    const formats = negotiateAudioFormats(this.voiceAI.name);
    this.outputFormat = formats;
    this.pipeline = resolveAudioPipeline(formats.output);
    this.toolRegistry = new Map(opts.tools.map((t) => [t.name, t]));
    this.toolDefinitions = opts.tools.map(toToolDefinition);
    this.audioPlaybackTracker = createAudioPlaybackTracker();
  }

  async start(): Promise<void> {
    const { telephony, systemPrompt } = this.opts;

    telephony.on('event', this.handleTelephonyEvent);
    this.voiceAI.on('event', this.handleVoiceAIEvent);

    try {
      const { providerCallId } = await this.opts.beginCall();
      this.providerCallId = providerCallId;
      await this.opts.onStatusChange({ kind: 'started', providerCallId });
    } catch (err) {
      await this.fail('telephony_originate_failed', err);
      return;
    }

    try {
      await this.voiceAI.connect({
        instructions: systemPrompt,
        ...(this.opts.frontendSystemPrompt !== undefined ? { frontendInstructions: this.opts.frontendSystemPrompt } : {}),
        tools: this.toolDefinitions,
        inputAudioFormat: this.outputFormat.input,
        outputAudioFormat: this.outputFormat.output,
      });
    } catch (err) {
      await this.fail('voice_ai_connect_failed', err);
      return;
    }

    // 'active' transition happens on the telephony 'connected' event (see
    // handleTelephonyEvent) — the call isn't actually live until the far end
    // picks up, which we only learn from the telephony leg.
  }

  private handleTelephonyEvent = (event: TelephonyEvent): void => {
    // TwilioProvider is a process-wide singleton (telephony/factory.ts)
    // broadcasting to every registered listener — with more than one call
    // potentially live at once (an outbound negotiation, an inbound
    // caller), this session must ignore events that aren't its own rather
    // than reacting to another call's audio/hangup/AMD signal.
    if (event.callId !== this.opts.callId) return;
    switch (event.type) {
      case 'connected':
        this.setState('active');
        if (this.opts.greetOnConnect) setTimeout(() => this.triggerVoiceAIResponse(), GREETING_DELAY_MS);
        break;
      case 'audio_chunk':
        // Phone audio in -> resample/convert -> feed the Voice AI model.
        this.voiceAI.sendAudioChunk(this.pipeline.inbound(event.chunk));
        break;
      case 'answering_machine_detected':
        // A concrete telephony-layer signal (Twilio AMD), not something the
        // model has to infer from audio alone. We just log it for now — the
        // model still drives the voicemail-vs-human branch via its own
        // leave_voicemail_and_end_call tool once it hears what's actually
        // playing, since AMD timing and the model's own judgment can diverge.
        logger.info({ callId: this.opts.callId, answeredBy: event.answeredBy }, 'Answering machine detection result');
        void this.opts.onStatusChange({ kind: 'answering_machine_detected', answeredBy: event.answeredBy });
        break;
      case 'ended':
        void this.end(event.reason);
        break;
      case 'error':
        void this.fail('telephony_error', event.error);
        break;
    }
  };

  private handleVoiceAIEvent = (event: VoiceAIEvent): void => {
    switch (event.type) {
      case 'audio_chunk': {
        // Model's speech out -> resample/convert -> send down the phone leg.
        // Concrete evidence the model is actually responding — cancel any
        // armed silence watchdog (see SILENCE_WATCHDOG_MS's doc comment).
        this.clearSilenceWatchdog();
        this.responseActive = true;
        const outboundChunk = this.pipeline.outbound(event.chunk);
        this.audioPlaybackTracker.recordChunkSent(outboundChunk.data.length);
        this.opts.telephony.sendAudio(this.opts.callId, outboundChunk);
        break;
      }
      case 'tool_call':
        // A tool call is also a response — the model reacted, it just isn't
        // speaking yet (e.g. check_my_availability before saying anything).
        this.clearSilenceWatchdog();
        this.responseActive = true;
        this.trackToolHandler(
          this.handleToolCall(event.call.id, event.call.name, event.call.arguments, event.call.unparsedArguments),
          this.toolBudgetMs(event.call.name),
        );
        break;
      case 'transcript':
        // Was previously unhandled entirely — we had zero visibility into
        // what either side actually said, which made a real bug (the model
        // ending a call within 4 seconds of a human answering, seemingly
        // without ever registering a spoken reply) impossible to diagnose
        // from logs alone. Only logging *final* transcripts (not the
        // streaming deltas some providers also emit) to keep this readable.
        //
        // PRODUCTION NOTE: raw spoken conversation content can contain PII,
        // medical/appointment details, identity-verification info like a
        // DOB a business asks for. Gated behind LOG_TRANSCRIPTS (off by
        // default, see src/config/index.ts) so it's opt-in for local-dev
        // debugging rather than an unconditional info-level log. The logger's
        // redact config (lib/logger.ts, #8) deliberately leaves this `text`
        // alone: turning LOG_TRANSCRIPTS on is asking to see it.
        if (!event.isFinal) break;
        {
          // #25: the transcriber finalises turns nobody spoke. Empty ones are
          // dropped; suspect ones are logged with a flag so they can't pass
          // for something the other party said.
          const quality = classifyTranscript(event.text);
          if (quality === 'empty') break;
          this.recordTranscript(event.role, event.text, quality);
          if (event.role === 'assistant' && this.firstAssistantLine === undefined) this.firstAssistantLine = event.text;
          if (event.role === 'assistant' && RECORDING_NOTICE.test(event.text) && this.opts.recordCalls && this.recordingState === 'idle') {
            this.recordingState = 'awaiting_turn_end';
          }
          if (config.LOG_TRANSCRIPTS) {
            logger.info(
              { callId: this.opts.callId, role: event.role, text: event.text, ...(quality === 'suspect' && { suspect: true }) },
              'transcript',
            );
          }
          if (quality === 'suspect') break;
        }
        // A finalized USER turn is exactly the moment the model is expected
        // to start responding (via OpenAI's server-side VAD auto-response,
        // in the OpenAI provider's case) — arm the silence watchdog here,
        // unconditional on LOG_TRANSCRIPTS. Deliberately does NOT re-arm if
        // already armed — see armSilenceWatchdogIfNeeded's doc comment. A
        // transcript the provider marks `answered` was already replied to
        // before it went final (full duplex), so there's nothing to wait for.
        // Empty and suspect turns never get here (#25): a hallucinated turn on
        // a silent line is not something the model is expected to answer.
        if (event.role === 'user' && !event.answered) this.armSilenceWatchdogIfNeeded();
        break;
      case 'interrupted':
        // #8: cut off before its turn ended, the recording notice may never
        // have reached the other party. Wait for Banjo to say it again.
        if (this.recordingState === 'awaiting_turn_end') this.recordingState = 'idle';
        // Caller barge-in — flush whatever we've already queued on the phone
        // leg, and reset the playback tracker's high-water mark: the
        // discarded buffered-but-unplayed audio will never actually play,
        // so keeping its estimated duration would over-estimate
        // estimatedDoneAt() for the rest of the call (see
        // audioPlaybackTracker.ts's reset() doc comment).
        this.opts.telephony.interrupt(this.opts.callId);
        this.audioPlaybackTracker.reset();
        break;
      case 'error':
        // Caught live (2026-09-01, callId d38b79ab): the silence watchdog's
        // nudge collided with a response OpenAI's own server-side VAD had
        // already started, producing a retryable error
        // ("conversation_already_has_active_response"). Failing the whole
        // call over a condition the provider itself flags as retryable tore
        // down a call that was otherwise fine — log and keep going instead.
        // A non-retryable error still ends the call exactly as before.
        if (event.error.retryable) {
          logger.warn({ callId: this.opts.callId, err: event.error }, 'Retryable Voice AI error — continuing the call rather than ending it');
          break;
        }
        void this.fail('voice_ai_error', event.error);
        break;
      case 'disconnected':
        void this.end(event.reason);
        break;
      case 'turn_end':
        this.clearSilenceWatchdog();
        this.responseActive = false;
        if (this.recordingState === 'awaiting_turn_end') this.scheduleRecordingStart();
        this.turnEndWaiters.splice(0).forEach((resolve) => resolve());
        break;
    }
  };

  /**
   * Deliberately does NOT reset the deadline if a watchdog is already armed —
   * on the live call this was caught from, the caller kept retrying every
   * few seconds ("Keeping up with me?", "Hello?", ...), each producing its
   * own finalized user transcript. Re-arming on every one of those would
   * have pushed the deadline back indefinitely and the watchdog would never
   * have fired at all. The deadline is set relative to the FIRST stalled
   * turn and stays fixed until something clears it.
   */
  private armSilenceWatchdogIfNeeded(): void {
    if (this.silenceWatchdog || this.callEndingToolCallId !== null) return;
    this.silenceNudgeSent = false;
    this.silenceWatchdog = setTimeout(() => this.handleSilenceWatchdogFired(), SILENCE_WATCHDOG_MS);
  }

  private clearSilenceWatchdog(): void {
    if (this.silenceWatchdog) clearTimeout(this.silenceWatchdog);
    this.silenceWatchdog = null;
    this.silenceNudgeSent = false;
  }

  private handleSilenceWatchdogFired(): void {
    this.silenceWatchdog = null;
    // Nothing to nudge while a call-ending tool runs (see callEndingToolCallId).
    if (this.callEndingToolCallId !== null) return;
    if (!this.silenceNudgeSent) {
      if (this.responseActive) {
        // A response we already know about (typically the opening greeting
        // we triggered ourselves) hasn't reached turn_end yet — sending
        // another triggerResponse() here is exactly the collision caught
        // live on 2026-09-01 (callId d38b79ab). Don't nudge; that response's
        // own turn_end/audio/tool_call will clear this watchdog normally.
        // Deliberately does NOT count as "the nudge" (silenceNudgeSent stays
        // false) — if that in-flight response never actually clears the
        // watchdog either, the give-up path below still needs to fire.
        logger.warn({ callId: this.opts.callId }, 'Silence watchdog fired but a response already appears to be in flight — skipping the nudge');
        return;
      }
      logger.warn({ callId: this.opts.callId }, 'Voice AI went silent after a user turn — nudging with an explicit response trigger');
      this.silenceNudgeSent = true;
      this.triggerVoiceAIResponse();
      this.silenceWatchdog = setTimeout(() => this.handleSilenceWatchdogFired(), SILENCE_WATCHDOG_MS);
      return;
    }
    logger.error({ callId: this.opts.callId }, 'Voice AI still silent after a nudge — ending the call');
    void this.fail('assistant_silence_watchdog', new Error('Voice AI produced no response after a user turn, even after an explicit nudge'));
  }

  /**
   * Starts recording once the turn that said the notice has finished PLAYING
   * (#8). A final transcript arrives when the model has written the line, not
   * when the phone has played it — on a live call that was ~4s early, before
   * "This call is recorded." was heard. Late is fine; early is the bug.
   */
  private scheduleRecordingStart(): void {
    const { telephony, callId } = this.opts;
    if (!telephony.startRecording) return;
    this.recordingState = 'scheduled';
    const delay = Math.max(0, this.audioPlaybackTracker.estimatedDoneAt() - Date.now()) + RECORDING_START_MARGIN_MS;
    this.recordingTimer = setTimeout(() => {
      this.recordingTimer = null;
      telephony
        .startRecording!(callId)
        .then(({ recordingId }) => this.opts.onStatusChange({ kind: 'recording_started', recordingId }))
        .catch((err) => logger.error({ err, callId }, 'failed to start call recording — the call continues unrecorded'));
    }, delay);
  }

  private cancelPendingRecording(): void {
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
  }

  private recordTranscript(role: 'user' | 'assistant', text: string, quality: 'ok' | 'suspect'): void {
    const seq = ++this.transcriptSeq;
    this.opts
      .onTranscript({ seq, role, text, quality, voiceProvider: this.voiceAI.name, spokenAt: new Date() })
      .catch((err) => logger.error({ callId: this.opts.callId, seq, role, textLength: text.length, err }, 'failed to save transcript line'));
  }

  /** Wraps voiceAI.triggerResponse() so every self-initiated response (greeting, silence-watchdog nudge) is reflected in responseActive — see its doc comment. */
  private triggerVoiceAIResponse(): void {
    this.responseActive = true;
    this.voiceAI.triggerResponse();
  }

  private async handleToolCall(
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    unparsedArguments?: string,
  ): Promise<void> {
    // The call is already over — end() may still be waiting on an earlier
    // handler with the voice AI connected. Don't run a new tool against a gone
    // call, and don't let setState('tool-pending') below overwrite 'ending':
    // that reopened end()'s guard, so the voice AI's 'disconnected' ended the
    // call a second time (duplicate end-of-call writes and SMS).
    if (this.state === 'ending' || this.state === 'ended' || this.state === 'error') {
      logger.warn({ callId: this.opts.callId, toolCallId, name, state: this.state }, 'Ignoring a tool call that arrived after the call ended');
      this.voiceAI.sendToolResult(toolCallId, { ok: false, error: 'call_ended' }, true);
      return;
    }
    const tool = this.toolRegistry.get(name);
    // A call-ending tool is still running (transfer_to_owner waiting on
    // Twilio). Refuse another call-ending tool without touching state or the
    // running tool's watchdog: a second end_call could hang up mid-transfer
    // (#7). A non-ending tool still runs — one response can carry end_call
    // and confirm_appointment together, and the booking must land.
    if (this.callEndingToolCallId !== null && tool?.endsCall) {
      logger.warn(
        { callId: this.opts.callId, toolCallId, name, callEndingToolCallId: this.callEndingToolCallId },
        'Refusing a tool call while a call-ending tool is still running',
      );
      this.voiceAI.sendToolResult(
        toolCallId,
        {
          ok: false,
          error: 'call_ending',
          message: 'An earlier tool call is already ending or transferring this call. Do not call another tool to end it; wait for its result.',
        },
        true,
      );
      return;
    }
    this.setState('tool-pending');
    // Session-level watchdog independent of each tool's own TOOL_TIMEOUT_MS —
    // if a call has been tool-pending unreasonably long, something is wrong
    // beyond a single slow API call, and we shouldn't trust every code path
    // to always eventually emit *something*.
    this.armToolPendingWatchdog(toolCallId, name, TOOL_PENDING_WATCHDOG_MS);

    if (!tool) {
      this.voiceAI.sendToolResult(toolCallId, { ok: false, error: 'unknown_tool' }, true);
      this.clearWatchdogAndResume(toolCallId);
      return;
    }

    // The vendor's arguments payload never parsed, so `args` is empty for a
    // reason that has nothing to do with what the model meant to send. Telling
    // it the arguments were *invalid* invites it to give up and improvise;
    // telling it the message was truncated invites it to send the call again.
    if (unparsedArguments !== undefined) {
      logger.warn(
        { callId: this.opts.callId, toolCallId, name, unparsedArguments },
        'tool call rejected: the vendor arguments payload could not be parsed',
      );
      this.voiceAI.sendToolResult(
        toolCallId,
        {
          ok: false,
          error: 'malformed_arguments',
          message: 'Your tool call arguments did not arrive as valid JSON and were likely truncated. Call the tool again with the complete arguments.',
        },
        true,
      );
      this.clearWatchdogAndResume(toolCallId);
      return;
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      // Logged as well as returned: this used to go only to the model, so a
      // rejected tool call left no trace in the logs at all.
      logger.warn(
        { callId: this.opts.callId, toolCallId, name, details: parsed.error.flatten() },
        'tool call rejected: arguments failed schema validation',
      );
      this.voiceAI.sendToolResult(toolCallId, { ok: false, error: 'invalid_arguments', details: parsed.error.flatten() }, true);
      this.clearWatchdogAndResume(toolCallId);
      return;
    }

    if (tool.endsCall) this.callEndingToolCallId = toolCallId;
    try {
      if (tool.endsCall) await this.waitForTurnEnd(TURN_END_WAIT_MS);
      // A tool with its own handler budget (VoiceTool.handlerBudgetMs) gets it
      // from here — the same point toolBudgetMs counts it from.
      if (tool.handlerBudgetMs !== undefined && !tool.verbatimMessage) this.armToolPendingWatchdog(toolCallId, name, tool.handlerBudgetMs);
      let verbatimDelivery: VerbatimDeliveryReport | undefined;
      if (tool.verbatimMessage) {
        // This forced turn can legitimately take much longer than a normal
        // tool call (reading an entire voicemail message aloud) — re-arm the
        // session-level watchdog with a larger budget before starting it, so
        // a real message doesn't get killed as if it were a stuck handler.
        this.armToolPendingWatchdog(toolCallId, name, VERBATIM_TOOL_PENDING_BUDGET_MS);
        await this.speakVerbatim(tool.verbatimMessage(parsed.data));
        // Only a provider that can't guarantee verbatim playback reports what
        // was actually said (openai-live); undefined leaves the handler on its
        // original trust-the-provider path.
        verbatimDelivery = this.voiceAI.verbatimDeliveryReport?.();
        if (verbatimDelivery && !verbatimDelivery.matched) {
          logger.warn({ callId: this.opts.callId, toolCallId, name }, 'Verbatim message delivery did not match the intended text');
        }
      }
      // Built AFTER any forced verbatim speech above so estimatedAudioDoneAt
      // reflects that speech's audio too — audioPlaybackTracker already
      // recorded it via the normal audio_chunk path (handleVoiceAIEvent),
      // regardless of why the model was speaking.
      const ctx = await this.opts.buildToolContext(this.audioPlaybackTracker.estimatedDoneAt(), verbatimDelivery);
      const result = await tool.handler(parsed.data, ctx);
      this.voiceAI.sendToolResult(toolCallId, result, false);
    } catch (err) {
      logger.error({ err, toolCallId, name }, 'Tool handler threw');
      this.voiceAI.sendToolResult(toolCallId, { ok: false, error: 'upstream_error' }, true);
    } finally {
      if (this.callEndingToolCallId === toolCallId) this.callEndingToolCallId = null;
      this.clearWatchdogAndResume(toolCallId);
    }
  }

  /**
   * Resolves once the current response's 'turn_end' fires, or after
   * timeoutMs if it never does — a missing/late signal shouldn't hang a
   * hang-up tool forever. See handleToolCall's endsCall branch.
   */
  private waitForTurnEnd(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.turnEndWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Forces `text` to be spoken verbatim (VoiceAIProvider.sayVerbatim) and
   * waits for that response to finish (its 'turn_end') before resolving —
   * see VoiceTool.verbatimMessage's doc comment for why a tool needs this
   * rather than trusting the model already said the right words earlier.
   */
  private speakVerbatim(text: string): Promise<void> {
    this.voiceAI.sayVerbatim(text);
    return this.waitForTurnEnd(SPEAK_VERBATIM_TIMEOUT_MS);
  }

  /**
   * (Re-)arms the session-level tool-pending watchdog: `budgetMs` from now,
   * the call fails as stuck. While a call-ending tool runs, the watchdog is
   * its budget and no other tool call may replace it (#7).
   */
  private armToolPendingWatchdog(toolCallId: string, name: string, budgetMs: number): void {
    if (this.callEndingToolCallId !== null && this.callEndingToolCallId !== toolCallId) return;
    if (this.toolPendingWatchdog) clearTimeout(this.toolPendingWatchdog);
    this.toolPendingWatchdogOwner = toolCallId;
    this.toolPendingWatchdog = setTimeout(() => {
      logger.error({ callId: this.opts.callId, toolCallId, name }, 'Tool call watchdog fired — forcing call end');
      void this.fail('tool_pending_watchdog', new Error(`Tool ${name} did not resolve in time`));
    }, budgetMs);
  }

  /**
   * A finishing tool call clears the watchdog and resumes 'active' only if the
   * watchdog is its own and no call-ending handler is still running — a tool
   * that started earlier and finishes mid-transfer must not disarm the
   * transfer's watchdog or mark the call 'active' (#7).
   */
  private clearWatchdogAndResume(toolCallId: string): void {
    if (this.toolPendingWatchdogOwner !== toolCallId || this.callEndingToolCallId !== null) return;
    if (this.toolPendingWatchdog) clearTimeout(this.toolPendingWatchdog);
    this.toolPendingWatchdog = null;
    this.toolPendingWatchdogOwner = null;
    if (this.state === 'tool-pending') this.setState('active');
  }

  private setState(state: CallSessionState): void {
    this.state = state;
  }

  private async fail(reason: string, err: unknown): Promise<void> {
    if (this.state === 'ended' || this.state === 'error' || this.state === 'ending') return;
    this.clearSilenceWatchdog();
    this.cancelPendingRecording();
    logger.error({ err, reason, callId: this.opts.callId }, 'Call session error');
    this.setState('error');
    // Same reason as end(): a booking still being written must land before
    // 'failed' is recorded and texted (#3). Setting 'error' first means no
    // new tool call can start while this waits.
    await this.waitForInFlightToolHandlers();
    await this.opts.onStatusChange({ kind: 'failed', reason, disclosure: checkDisclosure(this.firstAssistantLine) });
    // A dropped telephony/voice-AI leg has no PSTN-level way to auto-resume —
    // the caller would have to call back. Disconnect the other leg promptly
    // so we're not leaking billed connection time on a call that's already dead.
    await this.voiceAI.disconnect().catch(() => {});
    await this.hangUpTelephony();
    await this.opts.onFailure(reason);
    await this.opts.notifyIfTerminal();
  }

  /**
   * How long a tool call may legitimately run: the same budget its own
   * tool-pending watchdog gives it (#3). A verbatim tool first waits up to
   * TURN_END_WAIT_MS for turn_end, then gets VERBATIM_TOOL_PENDING_BUDGET_MS.
   * A tool with handlerBudgetMs (transfer_to_owner) gets that budget after its
   * endsCall turn_end wait, so end() keeps waiting for a redirect still in
   * flight instead of recording the call as failed over it (#7).
   */
  private toolBudgetMs(name: string): number {
    const tool = this.toolRegistry.get(name);
    if (tool?.verbatimMessage) return TURN_END_WAIT_MS + VERBATIM_TOOL_PENDING_BUDGET_MS;
    if (tool?.handlerBudgetMs !== undefined) return (tool.endsCall ? TURN_END_WAIT_MS : 0) + tool.handlerBudgetMs;
    return TOOL_PENDING_WATCHDOG_MS;
  }

  private trackToolHandler(run: Promise<void>, budgetMs: number): void {
    this.inFlightToolHandlers.set(run, Date.now() + budgetMs);
    run.finally(() => this.inFlightToolHandlers.delete(run)).catch(() => {});
  }

  /**
   * A tool handler still running when the call ends or fails — the callee
   * hanging up while confirm_appointment writes the calendar event — must
   * record its outcome before the call's end or failure is recorded.
   * Otherwise 'ended'/'failed' lands the task in 'failed' first and
   * notifyIfTerminal texts a failure for a booking that went through.
   *
   * Bounded by each running tool's own budget (toolBudgetMs), not a flat
   * TOOL_TIMEOUT_MS: that was shorter than what a call-ending or verbatim
   * tool is allowed, so a handler inside its budget could be overtaken (#3).
   */
  private async waitForInFlightToolHandlers(): Promise<void> {
    if (this.inFlightToolHandlers.size === 0) return;
    const latestDeadline = Math.max(...this.inFlightToolHandlers.values());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, latestDeadline - Date.now()) + IN_FLIGHT_TOOL_WAIT_MARGIN_MS);
    });
    await Promise.race([Promise.allSettled([...this.inFlightToolHandlers.keys()]), bound]);
    clearTimeout(timer);
  }

  /**
   * Ends a call from outside the session — the MCP stop_call tool's entry
   * point. Routes straight into the normal teardown rather than reaching for
   * the telephony provider directly, so an operator-stopped call is torn down
   * and persisted exactly like any other ending: Twilio hung up, the call
   * attempt closed out, the task failed with `reason` if it hadn't already
   * reached an outcome, and the usual notification fired.
   *
   * Safe to call on a session that is already ending or ended — `end` is a
   * no-op in those states.
   */
  async stop(reason: string): Promise<void> {
    logger.info({ callId: this.opts.callId, reason }, 'call stopped from outside the session');
    await this.end(reason);
  }

  private async end(reason: string): Promise<void> {
    if (this.state === 'ended' || this.state === 'error' || this.state === 'ending') return;
    this.clearSilenceWatchdog();
    this.cancelPendingRecording();
    this.setState('ending');
    await this.waitForInFlightToolHandlers();
    await this.opts.onStatusChange({ kind: 'ended', reason, disclosure: checkDisclosure(this.firstAssistantLine) });
    await this.voiceAI.disconnect().catch(() => {});
    await this.hangUpTelephony();
    this.setState('ended');
    logger.info({ callId: this.opts.callId, reason }, 'Call ended');
    await this.opts.notifyIfTerminal();
  }

  /**
   * Ends the actual PSTN leg. Mandatory on every non-tool-driven termination
   * path (fail(), and end() when reached via a voice-AI-initiated
   * disconnect rather than the telephony layer's own 'ended' event) —
   * this architecture bridges the call to our Media Streams WebSocket via
   * <Connect><Stream> (see TwilioProvider.buildTwiml), so the WebSocket
   * connection IS the live call as far as Twilio is concerned. Merely
   * disconnecting the Voice AI leaves that call live and bridged, just
   * silent: no more audio_chunks are produced, but nothing tells Twilio (or
   * the human on the other end) the call is over.
   *
   * Safe to call even when the telephony leg is already gone (e.g. end()
   * reached via the telephony layer's own 'ended' event, after which
   * TwilioProvider has already deleted its per-call state) —
   * TwilioProvider.hangUp() no-ops quietly in that case (it remembers calls
   * it recently ended), and any
   * REST error here is swallowed rather than blocking the rest of cleanup.
   */
  private async hangUpTelephony(): Promise<void> {
    await this.opts.telephony.hangUp(this.opts.callId).catch((err) => {
      logger.warn({ err, callId: this.opts.callId }, 'hangUpTelephony: telephony.hangUp() failed');
    });
  }
}
