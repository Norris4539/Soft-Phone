/**
 * The softphone itself: a thin, opinionated layer over SIP.js.
 *
 * SIP.js ships a `SimpleUser` helper, but it deliberately supports only one
 * call at a time and no attended transfer — which rules out the two things a
 * switchboard exists to do. So this drives the UserAgent directly.
 *
 * Everything asynchronous is funnelled into a single observable snapshot, so
 * React only ever renders from `getState()` and never has to reason about SIP
 * dialog state machines.
 */

import {
  Inviter,
  Invitation,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  UserAgentState,
  type Session,
  type URI,
} from 'sip.js';
import type {
  SessionDescriptionHandler,
  SessionDescriptionHandlerOptions as WebSdhOptions,
} from 'sip.js/lib/platform/web';

export type RegistrationState = 'unregistered' | 'registering' | 'registered' | 'failed';

export type CallDirection = 'inbound' | 'outbound';

export type CallStatus =
  | 'ringing' // inbound, not yet answered
  | 'connecting' // outbound, waiting for the far end
  | 'active'
  | 'held'
  | 'ended';

export interface CallView {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  /** The other party as a dialable string. */
  remoteNumber: string;
  remoteName: string;
  startedAt: number;
  /** When the call was answered; undefined while still ringing. */
  answeredAt?: number;
  muted: boolean;
  /** True for the second leg of an attended transfer. */
  consultation: boolean;
}

export interface PhoneState {
  registration: RegistrationState;
  registrationError?: string;
  /** The call the user is currently listening to, if any. */
  calls: CallView[];
  /** Set when an attended transfer is in progress. */
  pendingTransfer?: { fromCallId: string; toCallId: string };
  microphoneError?: string;
}

export interface PhoneConfig {
  websocketUrl: string;
  domain: string;
  username: string;
  password: string;
  displayName: string;
  iceServers: RTCIceServer[];
}

interface TrackedCall {
  id: string;
  session: Session;
  direction: CallDirection;
  status: CallStatus;
  remoteNumber: string;
  remoteName: string;
  startedAt: number;
  answeredAt?: number;
  muted: boolean;
  consultation: boolean;
}

type Listener = (state: PhoneState) => void;

/** Digits, plus the characters a SIP URI user part legitimately carries. */
const DIALABLE = /^[0-9*#+]+$/;

function sdhOf(session: Session): SessionDescriptionHandler | undefined {
  return session.sessionDescriptionHandler as SessionDescriptionHandler | undefined;
}

export class Phone {
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private config: PhoneConfig | null = null;

  private readonly calls = new Map<string, TrackedCall>();
  private readonly listeners = new Set<Listener>();

  private registration: RegistrationState = 'unregistered';
  private registrationError: string | undefined;
  private microphoneError: string | undefined;
  private pendingTransfer: PhoneState['pendingTransfer'];
  private nextId = 1;

  /** Where remote audio is played. Owned by index.html, not by React. */
  private get audioElement(): HTMLAudioElement | null {
    return document.getElementById('remote-audio') as HTMLAudioElement | null;
  }

  // --- observation ---------------------------------------------------------
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): PhoneState {
    return {
      registration: this.registration,
      registrationError: this.registrationError,
      microphoneError: this.microphoneError,
      pendingTransfer: this.pendingTransfer,
      calls: [...this.calls.values()].map((call) => ({
        id: call.id,
        direction: call.direction,
        status: call.status,
        remoteNumber: call.remoteNumber,
        remoteName: call.remoteName,
        startedAt: call.startedAt,
        answeredAt: call.answeredAt,
        muted: call.muted,
        consultation: call.consultation,
      })),
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  // --- lifecycle -----------------------------------------------------------
  async connect(config: PhoneConfig): Promise<void> {
    await this.disconnect();
    this.config = config;

    const uri = UserAgent.makeURI(`sip:${config.username}@${config.domain}`);
    if (!uri) throw new Error(`could not build a SIP URI for ${config.username}@${config.domain}`);

    this.ua = new UserAgent({
      uri,
      displayName: config.displayName,
      authorizationUsername: config.username,
      authorizationPassword: config.password,
      transportOptions: {
        server: config.websocketUrl,
        // Asterisk closes an idle WebSocket; keep it warm so an inbound call
        // does not arrive at a socket that is already gone.
        keepAliveInterval: 30,
      },
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: {
          iceServers: config.iceServers,
          // Gather relay candidates too, not just the first host candidate
          // that works — the far end may be the one behind the hard NAT.
          iceTransportPolicy: 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        },
        iceGatheringTimeout: 3000,
      },
      // Opus with in-band FEC survives packet loss far better than G.711, and
      // the browser negotiates it automatically when Asterisk offers it.
      delegate: {
        onInvite: (invitation) => this.onIncoming(invitation),
        onDisconnect: (error) => {
          if (!error) return;
          this.registration = 'failed';
          this.registrationError = 'Lost connection to the phone system. Reconnecting…';
          this.emit();
        },
      },
      logLevel: 'warn',
    });

    this.ua.stateChange.addListener((state) => {
      if (state === UserAgentState.Stopped) {
        this.registration = 'unregistered';
        this.emit();
      }
    });

    this.registration = 'registering';
    this.registrationError = undefined;
    this.emit();

    await this.ua.start();

    this.registerer = new Registerer(this.ua, {
      // Long enough not to churn, short enough that a closed tab stops
      // ringing within a couple of minutes.
      expires: 120,
    });

    this.registerer.stateChange.addListener((state) => {
      switch (state) {
        case RegistererState.Registered:
          this.registration = 'registered';
          this.registrationError = undefined;
          break;
        case RegistererState.Unregistered:
          // Only a surprise if we did not ask for it.
          if (this.registration === 'registered') this.registration = 'unregistered';
          break;
        case RegistererState.Terminated:
          this.registration = 'unregistered';
          break;
        default:
          break;
      }
      this.emit();
    });

    try {
      await this.registerer.register({
        requestDelegate: {
          onReject: (response) => {
            this.registration = 'failed';
            this.registrationError =
              response.message.statusCode === 401 || response.message.statusCode === 403
                ? 'The phone system rejected these credentials.'
                : `Registration rejected (${response.message.statusCode}).`;
            this.emit();
          },
        },
      });
    } catch (err) {
      this.registration = 'failed';
      this.registrationError = describeConnectError(err, config.websocketUrl);
      this.emit();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    for (const call of [...this.calls.values()]) {
      await this.hangup(call.id).catch(() => undefined);
    }
    this.calls.clear();

    try {
      await this.registerer?.unregister();
    } catch {
      // Unregistering is best-effort: the AoR expires on its own.
    }
    try {
      await this.ua?.stop();
    } catch {
      // Likewise.
    }

    this.registerer = null;
    this.ua = null;
    this.registration = 'unregistered';
    this.pendingTransfer = undefined;
    this.emit();
  }

  // --- placing and receiving ----------------------------------------------
  async call(destination: string, options: { consultation?: boolean } = {}): Promise<string> {
    if (!this.ua || !this.config) throw new Error('not connected');

    const target = normaliseDestination(destination);
    if (!DIALABLE.test(target)) throw new Error(`"${destination}" is not a number this can dial`);

    const uri = UserAgent.makeURI(`sip:${target}@${this.config.domain}`);
    if (!uri) throw new Error(`could not build a SIP URI for ${target}`);

    // Anything already up goes on hold — a second live audio stream is never
    // what the user meant, whether this is a consultation call or not.
    await this.holdOthers(null);

    const inviter = new Inviter(this.ua, uri, {
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
      earlyMedia: true,
    });

    const id = this.track(inviter, {
      direction: 'outbound',
      status: 'connecting',
      remoteNumber: target,
      remoteName: '',
      consultation: options.consultation ?? false,
    });

    try {
      await inviter.invite();
    } catch (err) {
      this.calls.delete(id);
      this.microphoneError = describeMediaError(err);
      this.emit();
      throw err;
    }

    return id;
  }

  private onIncoming(invitation: Invitation): void {
    const from = invitation.remoteIdentity;

    this.track(invitation, {
      direction: 'inbound',
      status: 'ringing',
      remoteNumber: from.uri.user ?? 'unknown',
      remoteName: from.displayName || '',
      consultation: false,
    });
  }

  async answer(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || !(call.session instanceof Invitation)) return;

    // Answering while another call is live would give the user two audio
    // streams at once; hold the others first.
    await this.holdOthers(callId);

    try {
      await call.session.accept({
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
      });
    } catch (err) {
      this.microphoneError = describeMediaError(err);
      this.emit();
      throw err;
    }
  }

  async reject(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;
    if (call.session instanceof Invitation) {
      // 486 sends the caller to voicemail rather than looking like a network
      // failure, which is what "decline" should mean.
      await call.session.reject({ statusCode: 486 });
    } else {
      await this.hangup(callId);
    }
  }

  async hangup(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;

    const { session } = call;
    switch (session.state) {
      case SessionState.Initial:
      case SessionState.Establishing:
        if (session instanceof Inviter) await session.cancel();
        else if (session instanceof Invitation) await session.reject();
        break;
      case SessionState.Established:
        await session.bye();
        break;
      default:
        break;
    }

    this.calls.delete(callId);
    this.emit();
  }

  // --- in-call controls ----------------------------------------------------
  setMuted(callId: string, muted: boolean): void {
    const call = this.calls.get(callId);
    const pc = sdhOf(call?.session as Session)?.peerConnection;
    if (!call || !pc) return;

    // Disabling the track rather than renegotiating: instant, and the far end
    // sees comfort noise instead of a re-INVITE.
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'audio') sender.track.enabled = !muted;
    }

    call.muted = muted;
    this.emit();
  }

  async setHold(callId: string, held: boolean): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.session.state !== SessionState.Established) return;

    // A re-INVITE with the direction attributes flipped is what actually puts
    // the far end on hold. `hold` belongs to the web SDH's options, which the
    // generic Session signature does not know about.
    await call.session.invite({
      sessionDescriptionHandlerOptions: { hold: held } as WebSdhOptions,
    });

    call.status = held ? 'held' : 'active';
    this.emit();
  }

  /** Send DTMF over RTP (RFC 4733), which is what the dialplan listens for. */
  sendDtmf(callId: string, tone: string): boolean {
    const call = this.calls.get(callId);
    const sdh = call ? sdhOf(call.session) : undefined;
    if (!sdh) return false;
    return sdh.sendDtmf(tone, { duration: 100, interToneGap: 70 });
  }

  /**
   * Blind transfer: hand the call to another extension and drop out of it.
   * The other party hears ringing at the destination; if nobody answers, the
   * dialplan's voicemail fallback catches it, not us.
   */
  async blindTransfer(callId: string, destination: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || !this.config) throw new Error('no such call');

    const target = normaliseDestination(destination);
    const uri = UserAgent.makeURI(`sip:${target}@${this.config.domain}`);
    if (!uri) throw new Error(`could not build a SIP URI for ${target}`);

    await call.session.refer(uri as URI);
    // The far end drives the transfer from here; the local leg ends once the
    // REFER is accepted, which arrives as a session state change.
  }

  /**
   * Attended transfer, step one: hold the caller and ring the destination so
   * the user can announce the call before completing it.
   */
  async startAttendedTransfer(callId: string, destination: string): Promise<string> {
    const call = this.calls.get(callId);
    if (!call) throw new Error('no such call');

    await this.setHold(callId, true);
    const consultationId = await this.call(destination, { consultation: true });

    this.pendingTransfer = { fromCallId: callId, toCallId: consultationId };
    this.emit();
    return consultationId;
  }

  /** Attended transfer, step two: connect the two parties and step out. */
  async completeAttendedTransfer(): Promise<void> {
    const transfer = this.pendingTransfer;
    if (!transfer) throw new Error('no transfer in progress');

    const original = this.calls.get(transfer.fromCallId);
    const consultation = this.calls.get(transfer.toCallId);
    if (!original || !consultation) throw new Error('one leg of the transfer has gone away');

    // Referring the held call to the live session is what makes this
    // "attended": the destination has already picked up.
    await original.session.refer(consultation.session);

    this.pendingTransfer = undefined;
    this.emit();
  }

  /** Abandon an attended transfer and go back to the original caller. */
  async cancelAttendedTransfer(): Promise<void> {
    const transfer = this.pendingTransfer;
    if (!transfer) return;

    await this.hangup(transfer.toCallId).catch(() => undefined);
    this.pendingTransfer = undefined;
    await this.setHold(transfer.fromCallId, false).catch(() => undefined);
    this.emit();
  }

  // --- internals -----------------------------------------------------------
  private track(
    session: Session,
    initial: Pick<
      TrackedCall,
      'direction' | 'status' | 'remoteNumber' | 'remoteName' | 'consultation'
    >,
  ): string {
    const id = `call-${this.nextId++}`;

    const call: TrackedCall = {
      id,
      session,
      startedAt: Date.now(),
      muted: false,
      ...initial,
    };

    this.calls.set(id, call);

    session.stateChange.addListener((state) => {
      switch (state) {
        case SessionState.Established: {
          call.status = 'active';
          call.answeredAt = Date.now();
          this.attachRemoteAudio(session);
          break;
        }
        case SessionState.Terminated: {
          this.calls.delete(id);
          // If a leg of a pending transfer dies, the transfer is off.
          if (
            this.pendingTransfer &&
            (this.pendingTransfer.fromCallId === id || this.pendingTransfer.toCallId === id)
          ) {
            this.pendingTransfer = undefined;
          }
          this.releaseAudioIfIdle();
          break;
        }
        default:
          break;
      }
      this.emit();
    });

    this.emit();
    return id;
  }

  /**
   * Point the page's single audio element at whichever session is live.
   * Reusing one element (rather than one per call) means switching between a
   * held call and a consultation call does not require a new autoplay grant.
   */
  private attachRemoteAudio(session: Session): void {
    const element = this.audioElement;
    const pc = sdhOf(session)?.peerConnection;
    if (!element || !pc) return;

    const stream = new MediaStream();
    for (const receiver of pc.getReceivers()) {
      if (receiver.track) stream.addTrack(receiver.track);
    }

    element.srcObject = stream;
    void element.play().catch((err) => {
      // Autoplay policy: this only happens if audio is attached before any
      // user gesture, which answering or dialling always is. Surface it
      // rather than leaving the user on a silent call.
      this.microphoneError = `Browser blocked call audio: ${String(err)}`;
      this.emit();
    });
  }

  private releaseAudioIfIdle(): void {
    if (this.calls.size > 0) return;
    const element = this.audioElement;
    if (element) element.srcObject = null;
  }

  /** Put every established call except `keepId` on hold. */
  private async holdOthers(keepId: string | null): Promise<void> {
    for (const call of this.calls.values()) {
      if (call.id === keepId) continue;
      if (call.session.state !== SessionState.Established) continue;
      if (call.status === 'held') continue;
      await this.setHold(call.id, true).catch(() => undefined);
    }
  }
}

/** Strip the punctuation people paste in from address books. */
export function normaliseDestination(input: string): string {
  return input.replace(/[\s()\-.]/g, '');
}

function describeConnectError(err: unknown, url: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/websocket|transport|connect/i.test(message)) {
    // By far the most common first-run failure, and the browser gives no
    // usable error for it, so name the cause explicitly.
    return (
      `Could not reach the phone system at ${url}. ` +
      `If this is a self-signed certificate, open ${url.replace('wss://', 'https://').replace('/ws', '/httpstatus')} ` +
      `once and accept the warning.`
    );
  }
  return message;
}

function describeMediaError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'Microphone access was denied. Allow it in the browser address bar, then try again.';
    case 'NotFoundError':
      return 'No microphone was found. Plug one in or select a different input device.';
    case 'NotReadableError':
      return 'The microphone is in use by another application.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
