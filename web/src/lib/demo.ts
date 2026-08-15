/**
 * Demo mode: the real interface, driven by a simulation instead of a PBX.
 *
 * This exists because a static host has no backend. Without it, a GitHub Pages
 * deployment is a login form that 404s — which demonstrates nothing. With it,
 * every screen and control is reachable and behaves correctly, so the UI can
 * be reviewed, shown to colleagues, and clicked through on a phone.
 *
 * What it cannot do is carry audio. There is no SIP stack and no media path
 * here, and the UI says so plainly rather than letting anyone conclude the
 * calling works. For real audio, point the same build at a real control server
 * with ?api=https://your-pbx, or run the stack locally — see docs/TESTING.md.
 */

import type {
  DirectoryEntry,
  PhoneConfigResponse,
  PublicUser,
  Snapshot,
} from './api';
import type { CallView, PhoneConfig, PhoneState, PhoneLike } from './phone';

const DEMO_USERS: (PublicUser & { password: string })[] = [
  {
    extension: '100',
    name: 'Reception',
    role: 'admin',
    groups: ['reception'],
    queues: [],
    password: 'demo',
  },
  {
    extension: '101',
    name: 'Alice Nguyen',
    role: 'agent',
    groups: ['reception'],
    queues: [{ name: 'sales', penalty: 0 }],
    password: 'demo',
  },
  {
    extension: '102',
    name: 'Ben Okafor',
    role: 'agent',
    groups: [],
    queues: [
      { name: 'sales', penalty: 1 },
      { name: 'support', penalty: 0 },
    ],
    password: 'demo',
  },
  {
    extension: '103',
    name: 'Carla Ruiz',
    role: 'agent',
    groups: [],
    queues: [{ name: 'support', penalty: 0 }],
    password: 'demo',
  },
];

const PRESENCE: Record<string, DirectoryEntry['status']> = {
  '100': 'available',
  '101': 'busy',
  '102': 'available',
  '103': 'offline',
};

let signedInAs: PublicUser = DEMO_USERS[1]!;

/** Any password is accepted; the point is to get past the door, not to guard it. */
export function demoLogin(extension: string) {
  const user = DEMO_USERS.find((u) => u.extension === extension) ?? DEMO_USERS[1]!;
  const { password: _ignored, ...publicUser } = user;
  signedInAs = publicUser;
  return { token: `demo.${extension}`, user: publicUser };
}

export function demoMe() {
  return { user: signedInAs };
}

export function demoDirectory() {
  return {
    users: DEMO_USERS.map(({ password: _p, ...user }) => ({
      ...user,
      status: PRESENCE[user.extension] ?? 'unknown',
      onCall: PRESENCE[user.extension] === 'busy',
    })) as DirectoryEntry[],
    ringGroups: { reception: { description: 'Main line' } },
    queues: { sales: { description: 'Sales' }, support: { description: 'Support' } },
  };
}

export function demoPhoneConfig(): PhoneConfigResponse {
  return {
    sip: {
      websocketUrl: 'wss://demo.invalid:8089/ws',
      domain: 'demo.invalid',
      extension: signedInAs.extension,
      username: signedInAs.extension,
      // Never a real secret — the demo has no SIP stack to authenticate to.
      password: 'not-a-real-credential',
      displayName: signedInAs.name,
    },
    ice: { iceServers: [] },
    switchboard: { mainDid: '15551234567', operatorExtension: '100' },
  };
}

const startedAt = Date.now();

/** A plausible switchboard, with the clock actually running. */
export function demoSnapshot(): Snapshot {
  const ageSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

  return {
    updatedAt: new Date().toISOString(),
    sources: { ari: true, ami: true },
    extensions: DEMO_USERS.map((user) => ({
      extension: user.extension,
      name: user.name,
      role: user.role,
      status: PRESENCE[user.extension] ?? 'unknown',
      registered: PRESENCE[user.extension] !== 'offline',
      channelIds: PRESENCE[user.extension] === 'busy' ? ['demo-channel-1'] : [],
    })),
    calls: [
      {
        id: 'demo-bridge-1',
        bridged: true,
        startedAt: iso(96 + ageSeconds),
        channels: [
          {
            id: 'demo-channel-1',
            name: 'PJSIP/101-00000001',
            endpoint: '101',
            external: false,
            state: 'Up',
            callerNumber: '101',
            callerName: 'Alice Nguyen',
            connectedNumber: '15558675309',
            connectedName: '',
            context: 'internal',
            exten: '',
            bridgeId: 'demo-bridge-1',
            startedAt: iso(96 + ageSeconds),
          },
          {
            id: 'demo-channel-2',
            name: 'PJSIP/primary-00000002',
            endpoint: 'primary',
            external: true,
            state: 'Up',
            callerNumber: '15558675309',
            callerName: 'J. Bergman',
            connectedNumber: '101',
            connectedName: '',
            context: 'from-trunk',
            exten: '15551234567',
            bridgeId: 'demo-bridge-1',
            startedAt: iso(96 + ageSeconds),
          },
        ],
      },
      {
        id: 'demo-channel-3',
        bridged: false,
        startedAt: iso(6),
        channels: [
          {
            id: 'demo-channel-3',
            name: 'PJSIP/primary-00000003',
            endpoint: 'primary',
            external: true,
            state: 'Ring',
            callerNumber: '15550101234',
            callerName: 'Unknown',
            connectedNumber: '',
            connectedName: '',
            context: 'from-trunk',
            exten: '15551234567',
            bridgeId: null,
            startedAt: iso(6),
          },
        ],
      },
    ],
    queues: [
      {
        name: 'sales',
        callers: [
          {
            channelId: 'demo-q-1',
            position: 1,
            callerNumber: '15557654321',
            callerName: 'M. Adeyemi',
            waitSeconds: 42 + ageSeconds,
          },
        ],
        members: [
          {
            extension: '101',
            name: 'Alice Nguyen',
            status: 'busy',
            paused: false,
            callsTaken: 7,
            lastCall: 0,
          },
          {
            extension: '102',
            name: 'Ben Okafor',
            status: 'available',
            paused: false,
            callsTaken: 4,
            lastCall: 0,
          },
        ],
        completed: 11,
        abandoned: 1,
      },
      {
        name: 'support',
        callers: [],
        members: [
          {
            extension: '102',
            name: 'Ben Okafor',
            status: 'available',
            paused: false,
            callsTaken: 2,
            lastCall: 0,
          },
          {
            extension: '103',
            name: 'Carla Ruiz',
            status: 'unavailable',
            paused: true,
            callsTaken: 0,
            lastCall: 0,
          },
        ],
        completed: 3,
        abandoned: 0,
      },
    ],
  };
}

/**
 * A Phone that goes through the motions without SIP or media.
 *
 * Implements the same interface as the real one, so App, CallPanel and the
 * rest are the genuine components — nothing about the UI is a mock-up.
 */
export class DemoPhone implements PhoneLike {
  private readonly listeners = new Set<(state: PhoneState) => void>();
  private readonly calls = new Map<string, CallView>();
  private registration: PhoneState['registration'] = 'unregistered';
  private pendingTransfer: PhoneState['pendingTransfer'];
  private nextId = 1;
  private timers: ReturnType<typeof setTimeout>[] = [];

  private later(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  subscribe(listener: (state: PhoneState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): PhoneState {
    return {
      registration: this.registration,
      pendingTransfer: this.pendingTransfer,
      calls: [...this.calls.values()],
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  async connect(_config: PhoneConfig): Promise<void> {
    this.registration = 'registering';
    this.emit();
    // A beat of latency, so the "Connecting…" state is visible rather than
    // flashing past in a single frame.
    this.later(() => {
      this.registration = 'registered';
      this.emit();
      // Ring after a short pause so the incoming-call UI is discoverable
      // without anyone having to know to expect it.
      this.later(() => this.simulateInbound(), 15000);
    }, 700);
  }

  async disconnect(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.calls.clear();
    this.registration = 'unregistered';
    this.pendingTransfer = undefined;
    this.emit();
  }

  private add(call: Omit<CallView, 'id'>): string {
    const id = `demo-call-${this.nextId++}`;
    this.calls.set(id, { ...call, id });
    this.emit();
    return id;
  }

  private simulateInbound(): void {
    // Only when the line is clear; interrupting a demo mid-call is annoying.
    if (this.calls.size > 0 || this.registration !== 'registered') {
      this.later(() => this.simulateInbound(), 15000);
      return;
    }
    this.add({
      direction: 'inbound',
      status: 'ringing',
      remoteNumber: '15558675309',
      remoteName: 'J. Bergman',
      startedAt: Date.now(),
      muted: false,
      consultation: false,
    });
  }

  async call(destination: string, options: { consultation?: boolean } = {}): Promise<string> {
    for (const call of this.calls.values()) {
      if (call.status === 'active') call.status = 'held';
    }

    const known = DEMO_USERS.find((u) => u.extension === destination);
    const id = this.add({
      direction: 'outbound',
      status: 'connecting',
      remoteNumber: destination,
      remoteName: known?.name ?? '',
      startedAt: Date.now(),
      muted: false,
      consultation: options.consultation ?? false,
    });

    this.later(() => {
      const call = this.calls.get(id);
      if (!call || call.status !== 'connecting') return;
      call.status = 'active';
      call.answeredAt = Date.now();
      this.emit();
    }, 1800);

    return id;
  }

  async answer(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;
    for (const other of this.calls.values()) {
      if (other.id !== callId && other.status === 'active') other.status = 'held';
    }
    call.status = 'active';
    call.answeredAt = Date.now();
    this.emit();
  }

  async reject(callId: string): Promise<void> {
    await this.hangup(callId);
  }

  async hangup(callId: string): Promise<void> {
    this.calls.delete(callId);
    if (
      this.pendingTransfer &&
      (this.pendingTransfer.fromCallId === callId || this.pendingTransfer.toCallId === callId)
    ) {
      this.pendingTransfer = undefined;
    }
    this.emit();
  }

  setMuted(callId: string, muted: boolean): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.muted = muted;
    this.emit();
  }

  async setHold(callId: string, held: boolean): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;
    call.status = held ? 'held' : 'active';
    this.emit();
  }

  sendDtmf(_callId: string, _tone: string): boolean {
    return true;
  }

  async blindTransfer(callId: string, _destination: string): Promise<void> {
    // A blind transfer drops us out of the call, same as the real thing.
    await this.hangup(callId);
  }

  async startAttendedTransfer(callId: string, destination: string): Promise<string> {
    await this.setHold(callId, true);
    const consultationId = await this.call(destination, { consultation: true });
    this.pendingTransfer = { fromCallId: callId, toCallId: consultationId };
    this.emit();
    return consultationId;
  }

  async completeAttendedTransfer(): Promise<void> {
    const transfer = this.pendingTransfer;
    if (!transfer) return;
    this.calls.delete(transfer.fromCallId);
    this.calls.delete(transfer.toCallId);
    this.pendingTransfer = undefined;
    this.emit();
  }

  async cancelAttendedTransfer(): Promise<void> {
    const transfer = this.pendingTransfer;
    if (!transfer) return;
    this.calls.delete(transfer.toCallId);
    this.pendingTransfer = undefined;
    await this.setHold(transfer.fromCallId, false);
  }
}
