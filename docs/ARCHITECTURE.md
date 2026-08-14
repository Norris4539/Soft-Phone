# Architecture

## The shape of it

```
  ┌──────────────────────────────────────────────┐
  │ browser                                      │
  │   React UI  ──►  SIP.js  ──►  WebRTC stack   │
  └───────┬────────────────────────┬─────────────┘
          │ HTTPS + WSS            │ SIP over WSS (:8089)
          │ (app, API, live state) │ DTLS-SRTP media
          ▼                        ▼
  ┌───────────────┐        ┌──────────────────┐        ┌──────────┐
  │ nginx (web)   │        │    Asterisk      │◄──────►│ SIP trunk│
  │ static + /api ├───────►│                  │ RTP    │ provider │
  └───────────────┘        │  dialplan        │ :5060  └──────────┘
                           │  queues          │
  ┌───────────────┐  ARI   │  voicemail       │        ┌──────────┐
  │ control server│◄──────►│                  │        │ coturn   │
  │ (Node/TS)     │  AMI   └──────────────────┘        │ STUN/TURN│
  └───────────────┘                                    └──────────┘
```

## The load-bearing decision

**Asterisk routes calls. The control server only observes and assists.**

ARI makes it possible to hand every call to a Stasis application and write the
routing in TypeScript. This project deliberately does not do that.

The dialplan owns routing, and the control server subscribes to events with
`subscribeAll=true` — a read-only view of everything, plus a few explicit
operator actions (hang up, transfer, originate, pause an agent).

What that buys:

- **The phones keep working when the control server does not.** Restart it,
  crash it, deploy a bad build — calls still arrive, ring, queue and record
  voicemail. Only the dashboard goes dark. For a system a company answers its
  phone with, that is the property worth optimising for.
- **The routing is inspectable.** `asterisk -rx "dialplan show internal"`
  prints exactly what will happen. Routing logic scattered across an event
  handler is not something you can ask a running system to show you.
- **Twenty years of edge cases are already handled.** Ring groups, queue
  strategies, hold music, DTMF, transfer semantics, voicemail — all of it is
  configuration, not code that has to be written and then debugged over the
  phone with an annoyed customer on the other end.

The cost is that changing routing means editing a dialplan and reloading,
rather than writing TypeScript. For a switchboard whose routing changes rarely,
that is a good trade.

## Components

### Asterisk (`infra/asterisk`)

Asterisk 20 LTS on Debian. The image is stock plus an entrypoint that renders
config templates from environment variables at boot, so a `docker compose
restart asterisk` picks up any change to `.env` or the templates.

Key configuration choices:

| File               | Why it looks the way it does                                             |
| ------------------ | ------------------------------------------------------------------------ |
| `pjsip.conf`       | Transports, the trunk, and a `webrtc-endpoint` template. WebRTC settings (DTLS, ICE, rtcp-mux, AVPF) travel together because a browser rejects the session if any one is missing. |
| `extensions.conf`  | The switchboard. Inbound routing, feature codes, outbound rules.          |
| `modules.conf`     | `autoload = yes`, then subtract. Naming modules explicitly is fragile — Debian ships the Opus codec as `codec_opus_open_source.so`, not `codec_opus.so`. |
| `asterisk.conf`    | No `[directories]` section: the compiled-in paths are right for whichever build is in the image, and they differ between Debian and Ubuntu. |
| `manager.conf`     | `deny` before `permit`. Asterisk applies ACL rules top to bottom and the last match wins, so a trailing deny-all silently locks everyone out. |
| `rtp.conf`         | No `stunaddr`. Asterisk's public address comes from `external_media_address`; a STUN lookup against the co-located coturn would return a container-private address and overwrite it. |

### Control server (`server`)

Node and TypeScript. Four jobs:

1. **Authenticate** users against `config/users.json` (scrypt) and issue JWTs.
2. **Hand out SIP credentials** to the browser — see [Security](#security).
3. **Maintain a live view** of the switchboard from ARI and AMI.
4. **Expose operator actions** for the dashboard.

Two Asterisk interfaces, because neither is sufficient:

- **ARI** for channels and bridges. Clean REST plus a WebSocket event stream.
- **AMI** for queues and hint states — neither of which ARI exposes. In
  particular `ARI /deviceStates` reports only states an ARI application created
  itself; on a system where the dialplan owns the hints it returns an empty
  list. Extension presence therefore comes from AMI's `ExtensionStateList` and
  `ExtensionStatus` events.

Both connections reconnect with exponential backoff, and both are resynced on a
30-second timer. Event streams drop messages across a reconnect, and a
dashboard that has quietly drifted out of date is worse than one that lags.

The AMI client is ~200 lines of plain text protocol handling rather than a
dependency. The wire format is `Key: Value` lines terminated by a blank line;
a library would be more code to audit than to write.

### Web app (`web`)

React, Vite, and SIP.js. Served by nginx, which also reverse-proxies `/api` to
the control server so the browser only ever sees one origin.

SIP.js ships a `SimpleUser` helper that handles one call at a time and cannot
do attended transfer — which rules out both things a switchboard exists to do.
`web/src/lib/phone.ts` drives the `UserAgent` directly instead, and funnels
everything into a single observable snapshot so React never has to reason about
SIP dialog state machines.

The remote `<audio>` element lives in `index.html`, outside React. A re-render
that recreated it would tear down the attached `MediaStream` and drop the
call's audio.

### coturn

STUN gets most browsers connected. TURN is the fallback for symmetric NAT and
for corporate networks that block UDP outright — which, for an internal company
tool, is not a rare case.

The peer ACL denies RFC1918 generally and allows exactly one subnet: the pinned
compose network, so a relayed candidate can still reach Asterisk. Without that
carve-out, TURN-relayed calls fail; without the general deny, the TURN server
is a proxy into the private network behind it.

## Data flow: an inbound call

1. The carrier sends an INVITE for the main DID to Asterisk on :5060.
2. `[from-trunk]` matches the DID and hands off to `[switchboard-inbound]`.
3. Business-hours check. Outside hours → company voicemail.
4. Inside hours → the IVR (if enabled and prompts are recorded) or straight to
   the reception ring group.
5. The ring group dials several `PJSIP/1XX` endpoints at once. Each browser
   gets an INVITE over its WebSocket and starts ringing.
6. Someone answers. Asterisk bridges the trunk's plain RTP to that browser's
   DTLS-SRTP — it must stay in the media path, since the two cannot talk
   directly.
7. Throughout, ARI emits channel and bridge events. The control server folds
   them into a snapshot and pushes it to every open dashboard.

## State model

`server/src/state.ts` holds three maps and derives a snapshot:

- **channels** — every live channel, from ARI
- **deviceStates** — extension presence, from AMI hint states
- **queues** — callers and members, from AMI

Calls are derived rather than stored: channels are grouped by bridge id, and a
channel not yet in a bridge is a call that is still ringing — which the
operator very much needs to see.

Snapshots are coalesced with a 120ms debounce. A single ring-group call fires a
dozen events in a few milliseconds, and the dashboard should see one coherent
update rather than a dozen partial ones.

## Security

**The browser receives a SIP password.** This is inherent: the browser *is* the
SIP endpoint and answers the digest challenge itself. There is no architecture
in which a WebRTC softphone does not hold a credential. The mitigations are
scope, not secrecy:

- credentials are returned only to an authenticated holder of a token for that
  exact extension
- each extension has its own secret, so rotating one affects one user
- the AoR allows 3 contacts and expires in 120 seconds, so a stolen credential
  used elsewhere is visible in `pjsip show contacts`

Everything else follows normal practice: JWTs signed with a secret the server
refuses to boot without in production, admin-only operator actions checked
server-side, per-extension login throttling, and ARI/AMI reachable only on the
compose network.

Roles are resolved from the user store on every request rather than trusted
from the token, so revoking an admin takes effect immediately rather than at
token expiry.
