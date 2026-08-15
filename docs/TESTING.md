# Testing without a trunk, and without Docker

You do not need a carrier account or a Docker daemon to run this and make real
calls. Everything below has been run and verified; nothing here is
"should work in theory".

What you get without a trunk: extension-to-extension calls with real audio, the
full inbound switchboard path (ring groups, queues, voicemail, IVR), presence,
and the operator dashboard.

What you genuinely cannot test without one: calls to and from the actual
telephone network.

---

## Running without Docker

The four containers are just four processes. Run them directly.

### 1. Asterisk

Debian, Ubuntu, or WSL:

```bash
sudo apt-get install -y asterisk asterisk-moh-opsound-gsm gettext-base
sudo systemctl stop asterisk        # we start it by hand, with our config
```

macOS: `brew install asterisk` works, but the paths differ from the ones the
entrypoint assumes. A Linux VM is less trouble.

Render this project's configuration into `/etc/asterisk` and start it:

```bash
./scripts/generate-dev-certs.sh
npm run users:init

sudo mkdir -p /etc/asterisk/templates /etc/asterisk/keys
sudo cp infra/asterisk/conf/*.conf /etc/asterisk/templates/
sudo cp infra/certs/asterisk.pem infra/certs/asterisk.key /etc/asterisk/keys/

sudo env \
  PUBLIC_HOSTNAME=localhost MAIN_DID=15551234567 MAIN_CALLER_ID_NAME="Test Co" \
  OPERATOR_EXTENSION=100 IVR_ENABLED=false OFFICE_HOURS='*,*,*,*' \
  TRUNK_ENABLED=false TRUNK_NAME=primary \
  RTP_START=10000 RTP_END=10200 \
  ARI_USERNAME=switchboard ARI_PASSWORD=devpass \
  AMI_USERNAME=switchboard AMI_PASSWORD=devpass \
  ./infra/asterisk/entrypoint.sh true

sudo asterisk -f -vvv        # foreground; Ctrl-C to stop
```

This overwrites the distribution's `/etc/asterisk`, so do it on a machine
where Asterisk is not doing anything else.

Note `TRUNK_ENABLED=false`. With no trunk configured, Asterisk will not spend
every 60 seconds retrying a registration against a host that does not exist.

### 2. Control server

```bash
cd server && npm install
NODE_ENV=development PORT=4000 \
JWT_SECRET=$(openssl rand -hex 32) \
ARI_URL=http://127.0.0.1:8088/ari ARI_USERNAME=switchboard ARI_PASSWORD=devpass \
AMI_HOST=127.0.0.1 AMI_USERNAME=switchboard AMI_PASSWORD=devpass \
USERS_FILE=../config/users.json PUBLIC_HOSTNAME=localhost \
npm run dev
```

Check it: `curl localhost:4000/api/health` should report `"status":"ok"` with
both `ari` and `ami` true. If `ami` is false the password is wrong or the ACL
in `manager.conf` is blocking you.

### 3. Web app

Either the Vite dev server, which proxies `/api` for you:

```bash
cd web && npm install && npm run dev      # http://localhost:5173
```

Or the built app behind the bundled static server, which is closer to
production because it exercises the real bundle:

```bash
npm --prefix web run build
node scripts/dev-serve.mjs --port 8090 --api http://127.0.0.1:4000
```

### 4. Accept the certificate

Open <https://localhost:8089/httpstatus> once and accept the warning. Skip this
and registration fails silently — browsers give no error for a WebSocket to an
untrusted certificate.

Then sign in at the app URL. `localhost` counts as a secure origin, so the
microphone works over plain HTTP.

---

## Making calls with no trunk

### Two extensions calling each other

The everyday case, and it needs nothing special. Sign in as 101 in one browser
and 102 in another — a second browser, a second profile, or a private window.
One profile holds one registration, so two tabs of the same profile will not
work.

Dial `102` from 101. You should hear each other.

### One machine, one browser

Dial `600`. Asterisk answers and echoes your microphone back. This proves
capture, DTLS-SRTP and the jitter buffer in one step, and is the fastest way to
tell a media problem from a signalling one.

`601` reads your caller ID back to you.

### Simulating an inbound call from the "carrier"

This is the useful one. Originate a channel that enters the dialplan exactly
where a real inbound call would, and the entire switchboard runs for real —
business hours, IVR, ring groups, queues, voicemail:

```bash
asterisk -rx "channel originate Local/15551234567@from-trunk application Wait 30"
```

Use your `MAIN_DID` in place of `15551234567`. Every registered extension in
the reception group rings at once. Whoever answers is connected to the
originating channel, which is sitting in `Wait(30)` — silence, but a real
answered call with a real media path.

Verified: this routes `from-trunk` → `switchboard-inbound` → `ring-groups` and
produces `Dial(PJSIP/100&PJSIP/101,25,tT)`.

To hear something instead of silence, swap the application:

```bash
asterisk -rx "channel originate Local/15551234567@from-trunk application Playback demo-congrats"
```

Jump straight to a queue, skipping the front of the dialplan:

```bash
asterisk -rx "channel originate Local/sales@queues application Wait 60"
asterisk -rx "queue show sales"
```

The caller appears in the queue with a running wait timer and is offered to
whichever agent the strategy picks. Pile up several to watch the dashboard's
queue view behave under depth.

Let a ring group go unanswered for its full 25 seconds to exercise the
voicemail tail.

### A desk-phone-style client

To test with something other than a browser, point any SIP client at the same
Asterisk — Linphone and Zoiper are both free:

| Setting   | Value                                   |
| --------- | --------------------------------------- |
| Username  | an unused extension, e.g. `103`         |
| Password  | that user's `sipPassword` in `users.json` |
| Domain    | `localhost` (or the machine's LAN IP)   |
| Transport | UDP or TCP on 5060                      |

Useful for confirming a problem is in the browser rather than in Asterisk.

### If you want real PSTN calls cheaply

There is no way around a carrier for this, but you do not need a contract.
Telnyx, Flowroute and Twilio all sell pay-as-you-go DIDs for roughly a dollar
a month with per-minute billing, and a few dollars of credit is plenty to
verify inbound and outbound end to end. Configure it as in
[DEPLOYMENT.md](DEPLOYMENT.md#sip-trunk-providers).

---

## The browser end-to-end test

`e2e/call-flow.mjs` drives two real Chromium instances through a complete call
and asserts that **RTP actually flowed**, rather than trusting the UI. A
softphone showing "In call" while nobody can hear anything is the failure worth
catching, and no other kind of test sees it.

```bash
cd e2e && npm install
cd .. && npm run test:e2e
```

It expects the app on <http://localhost:8090> (override with `APP_URL`) and the
example extensions 101 and 102. `HEADED=1` lets you watch.

Where the sandbox pins its own Chromium build, point at it:

```bash
CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
```

A passing run looks like:

```
Signing in
  ✓ 101 registered
  ✓ 102 registered

101 dials 102
  ✓ 102 sees an incoming call from "Alice Nguyen"
  ✓ both sides show an active call

Media
    101: recv 263 pkt / 8913 B, sent 263 pkt, lost 0, jitter 0
    102: recv 263 pkt / 7644 B, sent 263 pkt, lost 0, jitter 0
  ✓ audio flowing both ways
```

Roughly 250 packets over five seconds is 20ms ptime, which is correct. Byte
counts differing between directions at identical packet counts is Opus doing
variable-rate encoding — G.711 would be a flat 160 bytes per packet, so this is
also a check that codec negotiation landed where it should.

---

## The GitHub Pages demo

The workflow that publishes the web app to Pages is staged at
**`docs/pages-workflow.yml`**, not at `.github/workflows/pages.yml` where it
needs to live. GitHub requires the `workflow` OAuth scope to push anything into
`.github/workflows/`, and the automation that wrote it did not have that scope.

Activating it is two steps — one command, and one settings toggle that no
workflow can perform on its own:

```bash
mkdir -p .github/workflows
git mv docs/pages-workflow.yml .github/workflows/pages.yml
git commit -m "Enable GitHub Pages deployment"
git push
```

Then: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

After that it rebuilds on every push touching `web/`, and can be run by hand
from Actions → *Deploy demo to GitHub Pages* → Run workflow.

**Pages is static hosting.** It serves the bundle; it cannot run the control
server or Asterisk. So the published build runs in **demo mode**: the real
components driven by a simulation, with canned directory, queue and dashboard
data. Every screen and control is reachable, and it is useful for reviewing the
interface, showing colleagues, and checking the layout on a phone.

It cannot carry audio. There is no SIP stack and no media path in that build,
and the UI says so on the login screen and again in a banner once you are in —
no one should be able to mistake it for a working phone.

The site lands at `https://<owner>.github.io/<repo>/`.

### Pointing the demo at a real PBX

The same bundle is not demo-only. Give it a control server and it becomes the
real client:

```
https://<owner>.github.io/<repo>/?api=https://pbx.example.com
```

The value is remembered, so the query string is only needed once. There is also
a “Connect to a real server” control on the login screen. `?api=` with an empty
value forgets it and returns to the demo; `?demo=1` forces the demo back on.

Three things have to be true for that to work:

1. **The control server allows the origin.** It refuses unlisted cross-origin
   browsers, because these endpoints hand out SIP credentials. Set:

   ```ini
   CORS_ORIGIN=https://<owner>.github.io
   ```

2. **The control server is HTTPS.** A page served over HTTPS cannot call a
   plain-HTTP API; the browser blocks it as mixed content.

3. **Asterisk's WSS listener is reachable and trusted** from wherever the
   browser is. A self-signed development certificate will not do here — nothing
   is available to click "accept" on.

In other words: the front end can live on Pages, but the PBX still has to be
somewhere real. Pages removes the need to host the *static* part, nothing more.

### Running the demo locally

```bash
cd web && VITE_DEMO=1 npm run dev
```

Or add `?demo=1` to any deployment, including one wired to a real backend, when
you want the simulation instead.

## Inspecting a running system

```bash
asterisk -rx "pjsip show endpoints"        # who is provisioned
asterisk -rx "pjsip show contacts"         # who is actually registered
asterisk -rx "core show hints"             # what presence reports
asterisk -rx "core show channels"          # what is live right now
asterisk -rx "queue show"                  # queue depth and agents
asterisk -rx "dialplan show internal"      # what the dialplan really loaded

asterisk -rx "pjsip set logger on"         # every SIP message
asterisk -rx "rtp set debug on"            # where media is being sent
```

`core show channels` during a ring group is the clearest window into the
switchboard: you see the inbound leg and one outgoing leg per extension being
rung.

## Common stumbles

**Registration never completes.** The certificate. Visit
`https://localhost:8089/httpstatus` and accept it.

**Two tabs, one browser, second one will not register.** One profile holds one
registration. Use a second browser or a private window.

**Call connects but there is no audio.** Dial `600` first. If the echo test is
also silent it is local — microphone permission or device selection. If the
echo test works but calls do not, it is the RTP path.

**An extension shows offline while signed in.** `pjsip show contacts`. Status
`Unavail` means the qualify OPTIONS is going unanswered — a network path
problem, not a registration one.

**Dashboard is empty.** `curl localhost:4000/api/health`. `ami: false` means
the AMI credentials or the `manager.conf` ACL. Remember `deny` comes before
`permit`.
