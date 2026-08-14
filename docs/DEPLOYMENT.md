# Deployment

Getting this from a laptop onto a server that answers a real phone number.

## Before you start

Decide two things:

**A hostname.** Browsers need a secure origin for microphone access, and a
certificate they trust for the SIP WebSocket. Both need a real DNS name —
`phones.example.com`, say. An IP address will not do.

**Where it sits.** Asterisk needs a wide UDP port range reachable from your
carrier and from your users. A small VPS with a public IP is the simple case; a
machine behind corporate NAT means port forwarding for everything in
[Firewall](#firewall).

Sizing: for ten extensions and light call volume, 1 vCPU and 1GB is plenty.
Asterisk transcodes between the browser's Opus and the trunk's G.711 on every
external call, which is the main CPU cost. Budget roughly 30 concurrent calls
per core, and keep an eye on it before assuming.

## 1. Configure

```bash
git clone <your-repo> && cd Soft-Phone
cp .env.example .env
```

Everything in `.env` that must change:

```ini
PUBLIC_HOSTNAME=phones.example.com     # must match your certificate
ASTERISK_SIP_DOMAIN=phones.example.com

MAIN_DID=15551234567                   # digits only, no +
MAIN_CALLER_ID_NAME=Acme Inc
OPERATOR_EXTENSION=100
OFFICE_HOURS=09:00-17:00,mon-fri,*,*

TRUNK_ENABLED=true
TRUNK_HOST=sip.your-provider.com
TRUNK_AUTH=userpass
TRUNK_USERNAME=...
TRUNK_PASSWORD=...

JWT_SECRET=<openssl rand -hex 32>
ARI_PASSWORD=<openssl rand -hex 24>
AMI_PASSWORD=<openssl rand -hex 24>
TURN_PASSWORD=<openssl rand -hex 24>
TURN_REALM=phones.example.com
TURN_EXTERNAL_IP=203.0.113.10          # the server's public IP
```

The control server **refuses to start** in production with the example
`JWT_SECRET`. That is deliberate: a shipped default secret means anyone who has
read the repository can mint an admin token.

### Timezone

Business-hours routing uses the container's clock. If your office is not on
UTC, add to the asterisk service in `docker-compose.yml`:

```yaml
environment:
  TZ: America/New_York
```

Otherwise the after-hours message starts at the wrong time and it takes a while
to work out why.

## 2. Certificates

Two certificates are needed, and they can be the same one:

- **nginx**, for the web app — because microphone access requires HTTPS
- **Asterisk**, for the SIP WebSocket on :8089

With certbot:

```bash
certbot certonly --standalone -d phones.example.com

cp /etc/letsencrypt/live/phones.example.com/fullchain.pem infra/certs/asterisk.pem
cp /etc/letsencrypt/live/phones.example.com/privkey.pem   infra/certs/asterisk.key
docker compose restart asterisk
```

The entrypoint copies these into a location the `asterisk` user owns before
Asterisk drops privileges. Reading them straight from the read-only mount fails
with a bare "Permission denied" from OpenSSL and TLS silently stays off — so if
WSS is not listening, check that first.

**Renewal.** Let's Encrypt certificates last 90 days, and Asterisk does not
notice a file changing underneath it. Add a deploy hook:

```bash
# /etc/letsencrypt/renewal-hooks/deploy/softphone.sh
#!/bin/sh
set -e
cd /opt/Soft-Phone
cp /etc/letsencrypt/live/phones.example.com/fullchain.pem infra/certs/asterisk.pem
cp /etc/letsencrypt/live/phones.example.com/privkey.pem   infra/certs/asterisk.key
docker compose restart asterisk
```

A softphone fleet that stops registering three months after launch, all at
once, is the classic version of this mistake.

### Serving the web app over HTTPS

The `web` container speaks plain HTTP on :80 by design — put it behind a
reverse proxy that terminates TLS (Caddy, Traefik, or nginx on the host). Caddy
is two lines:

```
phones.example.com {
    reverse_proxy localhost:8080
}
```

Make sure the proxy forwards WebSocket upgrades; the dashboard's live feed is a
WebSocket on `/api/events`.

## 3. Extensions

```bash
cp config/users.example.json config/users.json
# edit: real names, real extensions, real passwords
npm run users:apply
```

`users:apply` hashes any plaintext passwords in place and generates SIP secrets
and voicemail PINs for anything left blank. Generated web passwords are printed
once — capture them then.

`config/users.json` holds password hashes and SIP secrets. It is gitignored;
keep it out of any image you build.

## 4. Firewall

| Port            | Proto | From        | For                            |
| --------------- | ----- | ----------- | ------------------------------ |
| 443             | TCP   | anywhere    | web app                        |
| 8089            | TCP   | anywhere    | SIP over WSS (browsers)        |
| 5060            | UDP   | **carrier** | SIP signalling                 |
| 10000–10200     | UDP   | anywhere    | RTP media                      |
| 3478            | UDP+TCP | anywhere  | STUN/TURN                      |
| 49160–49200     | UDP   | anywhere    | TURN relay                     |

**Restrict 5060 to your carrier's IP ranges.** An open 5060 is found by
scanners within hours, and the traffic is relentless. Every provider publishes
its signalling ranges.

Never expose **8088** (ARI) or **5038** (AMI). The compose file does not
publish them; do not add them.

Widen the RTP range for more concurrent calls — two ports per call, so
10000–10200 handles about 100. Change `RTP_START`/`RTP_END` together in `.env`;
the compose port mapping follows.

## 5. Start

```bash
make up
make status
```

`make status` should show your extensions and, with a registration trunk, a
`Registered` line. If the trunk shows `Rejected`, the credentials are wrong; if
`Trying` forever, a firewall is eating the traffic.

Watch a call being set up:

```bash
docker compose logs -f asterisk
docker compose exec asterisk asterisk -rx "pjsip set logger on"
```

## 6. Verify

In order, because each step rules out the layer below:

1. **Certificate** — `openssl s_client -connect phones.example.com:8089` should
   show your certificate, not a self-signed one.
2. **Registration** — sign in; the header should read *Ready*. If it does not,
   the browser console will show the WebSocket failing.
3. **Media** — dial `600`. If you hear your own voice, microphone capture,
   DTLS-SRTP and the jitter buffer all work.
4. **Internal calls** — two browsers, dial one from the other.
5. **Outbound** — call a mobile. Check the caller ID that arrives.
6. **Inbound** — call the main number from that mobile.

If signalling works but there is no audio, it is almost always RTP: either the
port range is not open, or `PUBLIC_HOSTNAME` is wrong so Asterisk is
advertising an address the far end cannot reach.

## SIP trunk providers

### Registration-based (Telnyx, Flowroute, most resellers)

```ini
TRUNK_ENABLED=true
TRUNK_AUTH=userpass
TRUNK_HOST=sip.telnyx.com
TRUNK_USERNAME=<your credential>
TRUNK_PASSWORD=<your credential>
```

### IP-authenticated (Twilio Elastic SIP Trunking, Bandwidth)

The provider recognises you by source address; there is no registration.

```ini
TRUNK_ENABLED=true
TRUNK_AUTH=ip
TRUNK_HOST=your-trunk.pstn.twilio.com
```

Register your server's public IP in the provider's portal as an authorised
origination address, and point the trunk's termination URI at
`sip:<your-host>:5060`. The `[identify]` section in `pjsip.conf` is what lets
inbound calls from them match the trunk endpoint.

Some providers need a distinct `From` identity:

```ini
TRUNK_FROM_USER=15551234567
TRUNK_FROM_DOMAIN=your-trunk.pstn.twilio.com
```

## TURN in production

The bundled coturn uses a long-term credential shipped to every browser via
`/api/config`. On a private network that is fine. On the public internet it is
a permanent relay account handed to anyone who can read a page's network tab.

For an internet-facing deployment, switch to ephemeral credentials: coturn's
`use-auth-secret` mode accepts a time-limited username/password derived from a
shared secret, which the control server can mint per session in
`server/src/routes/config.ts`. Set `static-auth-secret` in
`infra/coturn/turnserver.conf` and generate:

```
username = <unix timestamp + ttl>
password = base64(hmac-sha1(secret, username))
```

Until then, treat the TURN credential as public and rely on the peer ACL —
which already denies RFC1918 except the compose subnet — to limit the damage.

## Voicemail-to-email

Configured in `voicemail.conf` but inert: Asterisk shells out to a local MTA
and the container has none. Two options.

**An SMTP relay in the container.** Add `msmtp` to
`infra/asterisk/Dockerfile`, configure it for your provider, and point
`mailcmd` at it in `voicemail.conf`.

**Read the spool from outside.** Messages land in the `asterisk-spool` volume
under `voicemail/switchboard/<extension>/INBOX/`. Mount it somewhere and let
an external job deliver them. This keeps SMTP credentials out of the PBX
container, which is worth something.

## Backup

Three things matter:

| What                    | Where                                        |
| ----------------------- | -------------------------------------------- |
| Extensions and secrets  | `config/users.json`                          |
| Configuration           | `.env`, `infra/`                             |
| Voicemail and greetings | the `asterisk-spool` Docker volume           |

```bash
docker run --rm -v softphone_asterisk-spool:/data -v $(pwd):/backup \
  alpine tar czf /backup/voicemail-$(date +%F).tar.gz -C /data .
```

`config/users.json` and `.env` are the ones you cannot regenerate. Everything
else is in git.

## Upgrading

```bash
git pull
make up          # rebuilds changed images and restarts
make status
```

Compose restarts containers, which **drops calls in progress**. Do it out of
hours, or drain first by pausing agents and waiting for the queues to empty.

Asterisk config changes alone are cheaper:

```bash
make reload      # re-renders extensions and restarts only Asterisk
```

## Troubleshooting

**Registration fails, nothing in the browser console.**
Almost always the certificate. Open `https://phones.example.com:8089/httpstatus`
directly — if the browser complains, so does the WebSocket, silently.

**Registered, but calls have no audio.**
RTP. Check the UDP range is open end to end and that `PUBLIC_HOSTNAME` is the
address clients can actually reach. `asterisk -rx "rtp set debug on"` shows
where packets are being sent.

**Inbound calls ring nobody.**
`asterisk -rx "dialplan show from-trunk"` — does your DID match? Providers
differ on whether they send `+15551234567`, `15551234567` or `5551234567`. Turn
on `pjsip set logger on` and look at the INVITE's request URI.

**An extension shows offline while its user insists they are signed in.**
`asterisk -rx "pjsip show contacts"`. Status `Unavail` means the qualify OPTIONS
is not being answered — a network path problem, not a registration one.

**Dashboard is empty or says "partial view".**
`curl localhost:4000/api/health`. If `ami` is false, check `AMI_PASSWORD` and
the ACL in `manager.conf` — remember `deny` must come before `permit`.

**Queue callers hear silence instead of hold music.**
`asterisk -rx "moh show classes"`. An empty list means the
`asterisk-moh-opsound-gsm` package is missing from the image.
