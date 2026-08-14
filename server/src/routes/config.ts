import { Router } from 'express';

import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { sipCredentialsFor } from '../users.js';

export const configRouter = Router();

/**
 * Everything the browser needs to bring up its SIP stack.
 *
 * This includes the caller's own SIP secret.  That is unavoidable for a
 * WebRTC softphone — the browser is the SIP endpoint and must answer the
 * digest challenge itself — so the mitigation is scope rather than secrecy:
 * the credentials returned are only ever the token holder's own, and rotating
 * one (`manage-users.mjs passwd --ext N --sip`) invalidates only that user.
 */
configRouter.get('/', requireAuth, (req, res) => {
  const user = req.user!;

  res.json({
    sip: {
      websocketUrl: config.sipWebsocketUrl,
      domain: config.sipDomain,
      ...sipCredentialsFor(user),
    },
    ice: {
      // STUN first: it is enough for most networks and costs the relay
      // nothing.  TURN is the fallback for the ones where it is not.
      iceServers: [
        { urls: [`stun:${config.publicHostname}:3478`] },
        ...(config.turn.urls.length > 0 && config.turn.username
          ? [
              {
                urls: config.turn.urls,
                username: config.turn.username,
                credential: config.turn.password,
              },
            ]
          : []),
      ],
    },
    switchboard: {
      mainDid: config.mainDid,
      operatorExtension: process.env['OPERATOR_EXTENSION'] ?? '100',
    },
  });
});
