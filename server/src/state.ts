/**
 * Live switchboard state.
 *
 * Asterisk is the source of truth; this keeps a materialised view of it so the
 * dashboard can be handed a snapshot on connect and deltas thereafter, rather
 * than every browser polling ARI.
 *
 * Two feeds, because neither is complete on its own:
 *   ARI  — channels, bridges, device (extension) states
 *   AMI  — queues: who is waiting, and which agents are available
 *
 * Both are also resynced periodically.  Event streams drop messages across a
 * reconnect, and a dashboard that quietly drifts out of date is worse than one
 * that lags by a few seconds.
 */

import { EventEmitter } from 'node:events';

import { ami, type AmiMessage } from './ami.js';
import { ari, type AriEvent } from './ari.js';
import { log } from './logger.js';
import { listUsers } from './users.js';

export type ExtensionStatus =
  | 'available'
  | 'ringing'
  | 'busy'
  | 'onhold'
  | 'offline'
  | 'unknown';

export interface TrackedChannel {
  id: string;
  name: string;
  /** The PJSIP resource, e.g. "101" or the trunk name. */
  endpoint: string;
  /** True when this leg is the provider trunk rather than a desk extension. */
  external: boolean;
  state: string;
  callerNumber: string;
  callerName: string;
  connectedNumber: string;
  connectedName: string;
  context: string;
  exten: string;
  bridgeId: string | null;
  startedAt: string;
}

export interface ActiveCall {
  /** Bridge id when the legs are bridged, otherwise the lone channel's id. */
  id: string;
  bridged: boolean;
  startedAt: string;
  channels: TrackedChannel[];
}

export interface QueueCaller {
  channelId: string;
  position: number;
  callerNumber: string;
  callerName: string;
  waitSeconds: number;
}

export interface QueueMemberState {
  extension: string;
  name: string;
  status: string;
  paused: boolean;
  callsTaken: number;
  lastCall: number;
}

export interface QueueState {
  name: string;
  callers: QueueCaller[];
  members: QueueMemberState[];
  completed: number;
  abandoned: number;
}

export interface ExtensionState {
  extension: string;
  name: string;
  role: string;
  status: ExtensionStatus;
  registered: boolean;
  channelIds: string[];
}

export interface Snapshot {
  updatedAt: string;
  sources: { ari: boolean; ami: boolean };
  extensions: ExtensionState[];
  calls: ActiveCall[];
  queues: QueueState[];
}

/**
 * Hint states as AMI reports them, mapped onto something a UI can colour.
 *
 * These come from the dialplan hints (`exten => 101,hint,PJSIP/101`), which
 * is the only source that distinguishes ringing from in-use — an endpoint is
 * merely "online" for the whole duration of a call.
 *
 * Note that ARI's /deviceStates is *not* the equivalent: it only reports
 * device states an ARI application created itself, and returns an empty list
 * on a system like this one where the dialplan owns the hints.
 */
const HINT_STATE_MAP: Record<string, ExtensionStatus> = {
  Idle: 'available',
  InUse: 'busy',
  Busy: 'busy',
  Ringing: 'ringing',
  'InUse&Ringing': 'busy',
  Hold: 'onhold',
  'InUse&Hold': 'onhold',
  Unavailable: 'offline',
  Removed: 'offline',
  Unknown: 'unknown',
};


/** "PJSIP/101-00000003" -> "101" */
function endpointFromChannelName(name: string): string {
  const withoutTech = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  const dash = withoutTech.lastIndexOf('-');
  return dash === -1 ? withoutTech : withoutTech.slice(0, dash);
}

class SwitchboardState extends EventEmitter {
  private readonly channels = new Map<string, TrackedChannel>();
  private readonly deviceStates = new Map<string, ExtensionStatus>();
  private readonly queues = new Map<string, QueueState>();
  private readonly queueCallerJoinedAt = new Map<string, number>();

  private notifyTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;

  /** Extension numbers of endpoints that are not desk phones. */
  private trunkNames = new Set<string>();

  start(trunkName: string): void {
    if (trunkName) this.trunkNames.add(trunkName);

    ari.on('event', (event) => this.onAriEvent(event));
    ari.on('connected', () => void this.resyncChannels());
    ami.on('event', (message) => this.onAmiEvent(message));
    ami.on('connected', () => {
      void this.resyncQueues();
      void this.resyncExtensionStates();
    });

    // Belt and braces against dropped events; cheap at this scale.
    this.resyncTimer = setInterval(() => {
      void this.resyncChannels();
      void this.resyncQueues();
      void this.resyncExtensionStates();
    }, 30_000);
    this.resyncTimer.unref();
  }

  stop(): void {
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
  }

  // --- snapshot ------------------------------------------------------------
  snapshot(): Snapshot {
    const users = listUsers();
    const channelsByEndpoint = new Map<string, string[]>();

    for (const channel of this.channels.values()) {
      const list = channelsByEndpoint.get(channel.endpoint) ?? [];
      list.push(channel.id);
      channelsByEndpoint.set(channel.endpoint, list);
    }

    const extensions: ExtensionState[] = users.map((user) => {
      const status = this.deviceStates.get(user.extension) ?? 'unknown';
      return {
        extension: user.extension,
        name: user.name,
        role: user.role,
        status,
        // "Registered" means the softphone has a live contact; a browser that
        // was closed shows as offline within the AoR expiry.
        registered: status !== 'offline' && status !== 'unknown',
        channelIds: channelsByEndpoint.get(user.extension) ?? [],
      };
    });

    return {
      updatedAt: new Date().toISOString(),
      sources: { ari: ari.connected, ami: ami.connected },
      extensions,
      calls: this.buildCalls(),
      queues: [...this.queues.values()],
    };
  }

  private buildCalls(): ActiveCall[] {
    const byBridge = new Map<string, TrackedChannel[]>();
    const unbridged: TrackedChannel[] = [];

    for (const channel of this.channels.values()) {
      if (channel.bridgeId) {
        const list = byBridge.get(channel.bridgeId) ?? [];
        list.push(channel);
        byBridge.set(channel.bridgeId, list);
      } else {
        unbridged.push(channel);
      }
    }

    const calls: ActiveCall[] = [];

    for (const [bridgeId, channels] of byBridge) {
      const startedAt = channels
        .map((c) => c.startedAt)
        .sort()
        .at(0)!;
      calls.push({ id: bridgeId, bridged: true, startedAt, channels });
    }

    // A channel that is ringing has not reached a bridge yet, but it is very
    // much a call in progress and the operator needs to see it.
    for (const channel of unbridged) {
      calls.push({
        id: channel.id,
        bridged: false,
        startedAt: channel.startedAt,
        channels: [channel],
      });
    }

    return calls.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  // --- ARI -----------------------------------------------------------------
  private onAriEvent(event: AriEvent): void {
    switch (event.type) {
      case 'ChannelCreated':
      case 'ChannelStateChange':
      case 'ChannelDialplan':
      case 'ChannelCallerId':
      case 'ChannelConnectedLine':
      case 'ChannelHold':
      case 'ChannelUnhold':
      case 'StasisStart': {
        if (event.channel) this.upsertChannel(event.channel);
        break;
      }
      case 'ChannelDestroyed':
      case 'StasisEnd': {
        if (event.channel) this.channels.delete(event.channel.id);
        break;
      }
      case 'ChannelEnteredBridge': {
        if (event.channel && event.bridge) {
          this.upsertChannel(event.channel);
          const tracked = this.channels.get(event.channel.id);
          if (tracked) tracked.bridgeId = event.bridge.id;
        }
        break;
      }
      case 'ChannelLeftBridge': {
        if (event.channel) {
          const tracked = this.channels.get(event.channel.id);
          if (tracked) tracked.bridgeId = null;
        }
        break;
      }
      case 'BridgeDestroyed': {
        const bridgeId = event.bridge?.id;
        if (bridgeId) {
          for (const channel of this.channels.values()) {
            if (channel.bridgeId === bridgeId) channel.bridgeId = null;
          }
        }
        break;
      }
      // Extension presence deliberately does not come from ARI's
      // DeviceStateChanged — see HINT_STATE_MAP. AMI owns that map.
      default:
        return; // Nothing else changes the view; do not wake the dashboard.
    }

    this.scheduleNotify();
  }

  private upsertChannel(channel: AriEvent['channel'] & object): void {
    const existing = this.channels.get(channel.id);
    const endpoint = endpointFromChannelName(channel.name);

    this.channels.set(channel.id, {
      id: channel.id,
      name: channel.name,
      endpoint,
      external: this.trunkNames.has(endpoint) || !/^\d{3}$/.test(endpoint),
      state: channel.state,
      callerNumber: channel.caller?.number ?? '',
      callerName: channel.caller?.name ?? '',
      connectedNumber: channel.connected?.number ?? '',
      connectedName: channel.connected?.name ?? '',
      context: channel.dialplan?.context ?? '',
      exten: channel.dialplan?.exten ?? '',
      // A bridge id only ever arrives via ChannelEnteredBridge, so preserve it.
      bridgeId: existing?.bridgeId ?? null,
      startedAt: existing?.startedAt ?? channel.creationtime ?? new Date().toISOString(),
    });
  }

  private async resyncChannels(): Promise<void> {
    if (!ari.connected) return;
    try {
      const [channels, bridges] = await Promise.all([ari.listChannels(), ari.listBridges()]);

      const bridgeOf = new Map<string, string>();
      for (const bridge of bridges) {
        for (const channelId of bridge.channels) bridgeOf.set(channelId, bridge.id);
      }

      this.channels.clear();
      for (const channel of channels) {
        this.upsertChannel(channel);
        const tracked = this.channels.get(channel.id);
        if (tracked) tracked.bridgeId = bridgeOf.get(channel.id) ?? null;
      }

      this.scheduleNotify();
    } catch (err) {
      log.warn('ARI resync failed', { error: String(err) });
    }
  }

  /**
   * Extension presence, from the dialplan hints via AMI.  Also the recovery
   * path after an AMI reconnect, when any number of ExtensionStatus events
   * will have been missed.
   */
  private async resyncExtensionStates(): Promise<void> {
    if (!ami.connected) return;
    try {
      const messages = await ami.send('ExtensionStateList', {}, 'ExtensionStateListComplete');

      for (const message of messages) {
        if (message['Event'] !== 'ExtensionStatus') continue;
        const exten = message['Exten'];
        const statusText = message['StatusText'];
        if (!exten || !statusText) continue;
        this.deviceStates.set(exten, HINT_STATE_MAP[statusText] ?? 'unknown');
      }

      this.scheduleNotify();
    } catch (err) {
      log.warn('extension state resync failed', { error: String(err) });
    }
  }

  // --- AMI (queues) --------------------------------------------------------
  private onAmiEvent(message: AmiMessage): void {
    const event = message['Event'];
    const queueName = message['Queue'];

    switch (event) {
      case 'QueueCallerJoin': {
        if (!queueName) return;
        const queue = this.ensureQueue(queueName);
        const channelId = message['Uniqueid'] ?? message['Channel'] ?? '';
        this.queueCallerJoinedAt.set(channelId, Date.now());
        queue.callers = [
          ...queue.callers.filter((c) => c.channelId !== channelId),
          {
            channelId,
            position: Number(message['Position'] ?? queue.callers.length + 1),
            callerNumber: message['CallerIDNum'] ?? '',
            callerName: message['CallerIDName'] ?? '',
            waitSeconds: 0,
          },
        ];
        break;
      }
      case 'QueueCallerLeave':
      case 'QueueCallerAbandon': {
        if (!queueName) return;
        const queue = this.ensureQueue(queueName);
        const channelId = message['Uniqueid'] ?? message['Channel'] ?? '';
        queue.callers = queue.callers.filter((c) => c.channelId !== channelId);
        this.queueCallerJoinedAt.delete(channelId);
        if (event === 'QueueCallerAbandon') queue.abandoned += 1;
        break;
      }
      case 'QueueMemberStatus':
      case 'QueueMemberPause':
      case 'QueueMemberAdded':
      case 'QueueMemberRemoved': {
        if (!queueName) return;
        void this.resyncQueues();
        break;
      }
      case 'AgentComplete': {
        if (!queueName) return;
        this.ensureQueue(queueName).completed += 1;
        break;
      }
      case 'ExtensionStatus': {
        // Live hint changes: an extension starting to ring, answering, or
        // dropping off the system entirely.
        const exten = message['Exten'];
        const statusText = message['StatusText'];
        if (!exten || !statusText) return;
        this.deviceStates.set(exten, HINT_STATE_MAP[statusText] ?? 'unknown');
        break;
      }
      default:
        return;
    }

    this.scheduleNotify();
  }

  private ensureQueue(name: string): QueueState {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = { name, callers: [], members: [], completed: 0, abandoned: 0 };
      this.queues.set(name, queue);
    }
    return queue;
  }

  private async resyncQueues(): Promise<void> {
    if (!ami.connected) return;
    try {
      // QueueStatus streams a QueueParams + QueueMember + QueueEntry set per
      // queue, terminated by QueueStatusComplete.
      const messages = await ami.send('QueueStatus', {}, 'QueueStatusComplete');

      const rebuilt = new Map<string, QueueState>();
      let current: QueueState | null = null;

      for (const message of messages) {
        switch (message['Event']) {
          case 'QueueParams': {
            const name = message['Queue'];
            if (!name) break;
            current = {
              name,
              callers: [],
              members: [],
              completed: Number(message['Completed'] ?? 0),
              abandoned: Number(message['Abandoned'] ?? 0),
            };
            rebuilt.set(name, current);
            break;
          }
          case 'QueueMember': {
            if (!current) break;
            const location = message['Location'] ?? message['StateInterface'] ?? '';
            current.members.push({
              extension: endpointFromChannelName(location),
              name: message['Name'] ?? location,
              status: queueMemberStatus(message['Status'] ?? ''),
              paused: message['Paused'] === '1',
              callsTaken: Number(message['CallsTaken'] ?? 0),
              lastCall: Number(message['LastCall'] ?? 0),
            });
            break;
          }
          case 'QueueEntry': {
            if (!current) break;
            const channelId = message['Uniqueid'] ?? message['Channel'] ?? '';
            current.callers.push({
              channelId,
              position: Number(message['Position'] ?? 0),
              callerNumber: message['CallerIDNum'] ?? '',
              callerName: message['CallerIDName'] ?? '',
              waitSeconds: Number(message['Wait'] ?? 0),
            });
            break;
          }
          default:
            break;
        }
      }

      this.queues.clear();
      for (const [name, queue] of rebuilt) this.queues.set(name, queue);
      this.scheduleNotify();
    } catch (err) {
      log.warn('queue resync failed', { error: String(err) });
    }
  }

  // --- change notification -------------------------------------------------
  /**
   * A busy switchboard produces bursts of events — a single ring group call
   * fires a dozen in a few milliseconds.  Coalesce them so the dashboard gets
   * one coherent update rather than a dozen partial ones.
   */
  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.emit('change', this.snapshot());
    }, 120);
    this.notifyTimer.unref();
  }
}

/** AMI reports member status as a bare number. */
function queueMemberStatus(code: string): string {
  const map: Record<string, string> = {
    '0': 'unknown',
    '1': 'available',
    '2': 'busy',
    '3': 'busy',
    '4': 'unavailable',
    '5': 'unavailable',
    '6': 'ringing',
    '7': 'busy',
    '8': 'onhold',
  };
  return map[code] ?? 'unknown';
}

export const switchboard = new SwitchboardState();
