# Softphone Switchboard

A browser-based softphone and switchboard for a small company: **one main
phone number, many extensions**, with the call routing, queues and live
operator view that implies.

No desk phones, no client software — each employee signs in to a web page and
their browser *is* their extension.

---

## What it does

**For everyone**

- Sign in with an extension and password; the browser registers as that SIP
  endpoint
- Dial pad, click-to-call from the company directory, live presence (who is
  free, ringing, on a call)
- Answer, hold, mute, in-call keypad for IVRs
- Blind transfer ("send it over now") and attended transfer ("let me ask them
  first") — both, because a switchboard needs both
- Voicemail per extension, with optional voicemail-to-email

**For the operator / admin**

- Live view of every call on the system, with duration and both parties
- Transfer or end any call from the dashboard
- Queue monitor: who is waiting, how long, which agents are on
- Pause and resume agents in queues

**Routing**

- Inbound calls to the main number hit business-hours checks, then an IVR or
  the reception ring group
- Sales and support call queues with hold music and position announcements
- Per-extension direct dial numbers, if your carrier gives you a block
- Outbound calls present the company's main number by default, or a
  per-extension caller ID

---

## Architecture

```
   browser (React + SIP.js)
        │  SIP over secure WebSocket (wss :8089) ── signalling
        │  DTLS-SRTP ─────────────────────────── media
        ▼
   Asterisk 20  ──── PJSIP/RTP ────►  your SIP trunk provider ──► PSTN
        │  ARI (channels, bridges)          coturn :3478
        │  AMI (queues)                     STUN + TURN for NAT traversal
        ▼
   control server (Node/TypeScript)
        │  REST + WebSocket
        ▼
   browser dashboard
```

Four containers, started together by Docker Compose:

| Service    | What it is                                                          |
| ---------- | ------------------------------------------------------------------- |
| `asterisk` | The PBX. Registration, routing, queues, voicemail, media bridging.   |
| `coturn`   | STUN/TURN. Gets browsers connected from behind corporate firewalls.  |
| `server`   | Authenticates users, hands out SIP credentials, exposes live state.  |
| `web`      | The React app, served by nginx, which also proxies `/api`.           |

**Asterisk does the call routing; the control server only watches and
assists.** Calls are not routed through a Stasis application — the dialplan
stays in charge — so the switchboard keeps working exactly as configured even
if the control server is restarted or crashes. The dashboard goes dark; the
phones do not.

`config/users.json` is the single source of truth for extensions. A script
renders it into Asterisk configuration; the control server reads the same file
for logins.

---

## Getting started

Requires Docker, Docker Compose and Node 20+.

```bash
make setup     # .env, a JWT secret, a dev certificate, and example extensions
make up        # build and start everything
```

Then — **and this step is not optional** —

```
open https://localhost:8089/httpstatus
```

and accept the certificate warning. Browsers refuse a WebSocket to an
untrusted certificate, and unlike a normal page there is no prompt when it
happens: registration simply fails with nothing in the console. Accepting the
certificate once per browser fixes it. (In production you install a real
certificate instead; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).)

Now open <http://localhost:8080> and sign in.

`make setup` creates four example extensions with the passwords from
`config/users.example.json`:

| Extension | Name          | Role  | Password              |
| --------- | ------------- | ----- | --------------------- |
| 100       | Reception     | admin | `change-me-reception` |
| 101       | Alice Nguyen  | agent | `change-me-alice`     |
| 102       | Ben Okafor    | agent | `change-me-ben`       |
| 103       | Carla Ruiz    | agent | `change-me-carla`     |

They are hashed on first use, so those strings only work once, before you
change them. Change them.

### Check it works

Sign in as 101 in one browser and 102 in another (a second profile or a
private window — one browser profile holds one registration). Dial `102` from
101. You should hear each other.

If you would rather test alone, dial `600` — an echo test that proves your
microphone, the DTLS-SRTP media path and the jitter buffer are all working. It
is the fastest way to tell a media problem from a signalling one.

Or let two browsers do it for you:

```bash
make test-e2e
```

That drives two Chromium instances through a complete call and asserts RTP
actually flowed in both directions — a softphone reporting "In call" while
nobody can hear anything is the failure worth catching.

**No trunk and no Docker?** You can still make and receive calls, including
through the ring groups, queues and voicemail. See
[docs/TESTING.md](docs/TESTING.md).

**Just want to see the interface?** A UI demo is published at
<https://norris4539.github.io/Soft-Phone/> — the real screens driven by a
simulation. It has no phone system behind it and carries no audio.

---

## Managing extensions

Everything lives in `config/users.json`. Edit it and re-apply, or use the CLI:

```bash
npm run users:list
npm run users:add -- --ext 104 --name "Dana Weiss" --queues support:0 --email dana@example.com
npm run users:passwd -- --ext 104
node scripts/manage-users.mjs remove --ext 104

make reload      # re-render the Asterisk config and restart Asterisk
```

Plaintext passwords written into `users.json` are hashed in place the next time
the script runs, so it is safe to type one in by hand. SIP secrets and
voicemail PINs are generated if you leave them out.

`config/users.json` is gitignored — it holds password hashes and SIP secrets.

---

## Connecting a real phone number

Out of the box the trunk is disabled and only internal calls work. To connect
a carrier (Telnyx, Twilio Elastic SIP Trunking, Bandwidth, Flowroute…), set
these in `.env`:

```ini
TRUNK_ENABLED=true
TRUNK_HOST=sip.your-provider.com
TRUNK_AUTH=userpass          # or `ip` for an IP-authenticated trunk
TRUNK_USERNAME=...
TRUNK_PASSWORD=...
MAIN_DID=15551234567         # digits only, no leading +
```

then `make reload` and check the registration:

```bash
make status
```

Full walkthrough, including firewall rules and going to production:
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Call routing

The switchboard logic is the dialplan, in
`infra/asterisk/conf/extensions.conf`. What arrives where:

| Dial            | What happens                                              |
| --------------- | --------------------------------------------------------- |
| `1XX`           | Rings that extension; falls to their voicemail             |
| `0`             | Reception ring group                                       |
| `*97`           | Your voicemail                                             |
| `*98`           | Voicemail for another mailbox                              |
| `*8`            | Pick up a ringing call at reception                        |
| `*8XXX`         | Pick up a ringing call at that extension                   |
| `*XXX`          | Straight to that extension's voicemail, without ringing    |
| `*45`           | Pause/resume yourself in your queues                       |
| `600`           | Echo test                                                  |
| `601`           | Read back your caller ID                                   |
| `9` + number    | Outbound, if you like dialling 9 for a line                |
| a full number   | Outbound                                                   |

Inbound calls to the main number are described in
[docs/DIALPLAN.md](docs/DIALPLAN.md), along with how to change the IVR, ring
groups and queues.

The IVR is **off by default**, because it needs recorded prompts and Asterisk
ships nothing resembling "press 1 for sales". Until you record them, inbound
calls go straight to the reception ring group, which needs no audio. See
`scripts/generate-prompts.sh` when you are ready.

---

## Development

```bash
make dev-server    # control server on :4000, watching for changes
make dev-web       # Vite dev server on :5173, proxying /api to :4000
make check         # typecheck both
make logs SERVICE=asterisk
make status        # registrations, channels and queues from the Asterisk CLI
```

The web dev server proxies `/api` to the control server, so a browser sees one
origin in development exactly as it does in production.

```
├── infra/asterisk/     Dockerfile, entrypoint, config templates
├── infra/coturn/       TURN server configuration
├── scripts/            extension provisioning, certificates, IVR prompts
├── config/             users.json — extensions, ring groups, queues
├── server/             control server (TypeScript)
├── web/                React softphone and dashboard
└── docs/               architecture, deployment, dialplan
```

---

## Security notes

Worth understanding before this carries real calls:

- **The browser gets a SIP password.** It has to — the browser is the SIP
  endpoint and answers the digest challenge itself. Each user only ever
  receives their own credentials, over an authenticated API call, and rotating
  one affects only that user. It is not a secret you can keep from the client.
- **Serve the app over HTTPS.** Browsers only grant microphone access on a
  secure origin (`localhost` excepted), and the JWT travels with every request.
- **Do not publish ports 8088 or 5038.** ARI and AMI have no business being
  reachable from outside the compose network; the compose file deliberately
  does not map them.
- **Change `JWT_SECRET`.** The server refuses to start in production with the
  example value, and warns loudly in development.
- **Use ephemeral TURN credentials** if the TURN server is internet-facing.
  The bundled long-term credential is fine on a private network and is
  discussed in the deployment guide.
