/** Directory, live state, and the operator actions the dashboard offers. */

import { Router } from 'express';

import { ami } from '../ami.js';
import { ari } from '../ari.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { log } from '../logger.js';
import { switchboard } from '../state.js';
import { findUser, listQueues, listRingGroups, listUsers } from '../users.js';

export const switchboardRouter = Router();

switchboardRouter.use(requireAuth);

/** The company directory, with presence, for the softphone's contacts list. */
switchboardRouter.get('/directory', (_req, res) => {
  const snapshot = switchboard.snapshot();
  const presence = new Map(snapshot.extensions.map((e) => [e.extension, e]));

  res.json({
    users: listUsers().map((user) => ({
      ...user,
      status: presence.get(user.extension)?.status ?? 'unknown',
      onCall: (presence.get(user.extension)?.channelIds.length ?? 0) > 0,
    })),
    ringGroups: listRingGroups(),
    queues: listQueues(),
  });
});

/** Snapshot of live state — the same payload the WebSocket pushes. */
switchboardRouter.get('/state', (req, res) => {
  const snapshot = switchboard.snapshot();
  if (req.user!.role === 'admin') {
    res.json(snapshot);
    return;
  }
  res.json({
    ...snapshot,
    calls: snapshot.calls.filter((call) =>
      call.channels.some((channel) => channel.endpoint === req.user!.extension),
    ),
  });
});

// --- Operator actions ------------------------------------------------------
// These act on other people's calls, so they are admin-only.  An agent
// controls their own call through SIP from their browser, not through here.

switchboardRouter.post('/calls/:channelId/hangup', requireAdmin, async (req, res) => {
  const channelId = String(req.params['channelId']);
  try {
    await ari.hangup(channelId);
    log.info('operator hung up a channel', { by: req.user!.extension, channelId });
    res.status(204).end();
  } catch (err) {
    log.warn('hangup failed', { channelId, error: String(err) });
    res.status(502).json({ error: 'could not hang up that channel' });
  }
});

/** Blind transfer of a live channel to an extension. */
switchboardRouter.post('/calls/:channelId/transfer', requireAdmin, async (req, res) => {
  const channelId = String(req.params['channelId']);
  const target = String(req.body?.extension ?? '').trim();

  if (!findUser(target)) {
    res.status(400).json({ error: `no such extension: ${target}` });
    return;
  }

  try {
    // `continue` puts the channel back into the dialplan at the target, which
    // reuses internal-dial and therefore keeps voicemail fallback, hints and
    // CDR tagging identical to any other internal call.
    await ari.continueInDialplan(channelId, 'internal-dial', target, 1);
    log.info('operator transferred a call', { by: req.user!.extension, channelId, target });
    res.status(204).end();
  } catch (err) {
    log.warn('transfer failed', { channelId, target, error: String(err) });
    res.status(502).json({ error: 'could not transfer that channel' });
  }
});

/**
 * Ring an extension and, when it answers, dial an outside number from it.
 * This is the classic switchboard move: the operator connects two parties
 * without being in the middle of the call.
 */
switchboardRouter.post('/calls/originate', requireAdmin, async (req, res) => {
  const from = String(req.body?.from ?? '').trim();
  const to = String(req.body?.to ?? '').trim();

  if (!findUser(from)) {
    res.status(400).json({ error: `no such extension: ${from}` });
    return;
  }
  if (!/^[0-9*#+]{1,20}$/.test(to)) {
    res.status(400).json({ error: 'destination must be digits' });
    return;
  }

  try {
    await ami.send('Originate', {
      Channel: `PJSIP/${from}`,
      Context: 'internal',
      Exten: to,
      Priority: '1',
      CallerID: `Switchboard <${from}>`,
      Async: 'true',
      Timeout: '30000',
    });
    log.info('operator originated a call', { by: req.user!.extension, from, to });
    res.status(202).json({ status: 'originating' });
  } catch (err) {
    log.warn('originate failed', { from, to, error: String(err) });
    res.status(502).json({ error: 'could not place that call' });
  }
});

// --- Queue control ---------------------------------------------------------

/** Pause or resume a queue member. Agents may only change their own state. */
switchboardRouter.post('/queues/:queue/members/:extension/pause', async (req, res) => {
  const queue = String(req.params['queue']);
  const extension = String(req.params['extension']);
  const paused = Boolean(req.body?.paused);

  if (req.user!.role !== 'admin' && req.user!.extension !== extension) {
    res.status(403).json({ error: 'you can only change your own queue status' });
    return;
  }
  if (!findUser(extension)) {
    res.status(400).json({ error: `no such extension: ${extension}` });
    return;
  }

  try {
    await ami.send('QueuePause', {
      Interface: `PJSIP/${extension}`,
      Paused: paused ? 'true' : 'false',
      // Omitting Queue pauses the member in every queue they belong to, which
      // is what "I'm stepping away" means; naming one is the exception.
      ...(queue === 'all' ? {} : { Queue: queue }),
      Reason: `set by ${req.user!.extension}`,
    });
    log.info('queue pause changed', { by: req.user!.extension, extension, queue, paused });
    res.status(204).end();
  } catch (err) {
    log.warn('queue pause failed', { extension, queue, error: String(err) });
    res.status(502).json({ error: 'could not change queue status' });
  }
});
