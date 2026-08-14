# The dialplan

The switchboard's behaviour lives in `infra/asterisk/conf/extensions.conf`, plus
`extensions_users.conf` and `extensions_did.conf`, which are generated from
`config/users.json`.

After any change: `make reload`.

To see what Asterisk actually loaded — always worth checking, because a typo in
a pattern produces a context that silently matches nothing:

```bash
docker compose exec asterisk asterisk -rx "dialplan show internal"
docker compose exec asterisk asterisk -rx "dialplan show switchboard-inbound"
```

## Contexts

| Context                | Role                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `from-trunk`           | Entry point for the carrier. Kept tiny — everything reachable from here is reachable by the internet. |
| `switchboard-inbound`  | Business hours, then IVR or ring group.                     |
| `ivr-main`             | The menu.                                                   |
| `ivr-extension`        | Dial-by-extension, behind IVR option 3.                     |
| `ring-groups`          | Ring several extensions at once or in turn.                 |
| `queues`               | Sales and support queues with the overflow tail.            |
| `internal`             | What a signed-in softphone can dial. Extensions live here.  |
| `internal-dial`        | The one place an extension is actually dialled.             |
| `outbound`             | Caller ID rules and the trunk.                              |

Endpoints are placed in `internal`. They cannot reach `from-trunk`, and calls
arriving on the trunk cannot reach `outbound` except through the routes the
switchboard explicitly offers — so a caller cannot use the PBX to dial out at
your expense.

## Inbound

```
carrier ──► [from-trunk]
              │  DID matches MAIN_DID (bare, +prefixed, or as 's')
              ▼
            [switchboard-inbound] s
              │  Answer, then GotoIfTime(OFFICE_HOURS)
              ├── outside hours ──► company voicemail
              └── inside hours
                    ├── IVR_ENABLED=true  ──► [ivr-main]
                    └── IVR_ENABLED=false ──► [ring-groups] reception
```

Anything arriving on the trunk addressed to something we do not recognise is
hung up, not passed along.

### Business hours

`OFFICE_HOURS` in `.env` uses Asterisk's `GotoIfTime` syntax:

```
<time range>,<days of week>,<days of month>,<months>
```

```ini
OFFICE_HOURS=09:00-17:00,mon-fri,*,*     # weekday office hours
OFFICE_HOURS=*,*,*,*                     # always open
OFFICE_HOURS=08:30-18:00,mon-sat,*,*     # includes Saturday
```

Times are in the container's timezone (UTC unless you set `TZ` on the asterisk
service). If your office is not on UTC, set it — otherwise the after-hours
message starts at the wrong time of day and it will take someone a while to
work out why.

### The IVR

Off by default. `IVR_ENABLED=true` turns it on, but it needs recorded prompts
first — Asterisk's bundled sound library has nothing resembling "press 1 for
sales", so with the flag on and no prompt, callers hear silence.

```bash
./scripts/generate-prompts.sh synth            # espeak-ng, for testing
./scripts/generate-prompts.sh convert menu.wav # your own recording
./scripts/generate-prompts.sh install
# then set IVR_ENABLED=true and: make reload
```

The default menu:

| Key | Destination           |
| --- | --------------------- |
| 1   | Sales queue           |
| 2   | Support queue         |
| 3   | Dial by extension     |
| 0   | Reception ring group  |

After three loops with no valid input, callers go to reception. Invalid input
replays the menu.

**The menu is single-digit only, deliberately.** Offering both "press 1" and
"dial extension 1XX" in the same context makes Asterisk wait for two more
digits after the caller presses 1, to see whether a longer pattern will match.
To the caller that is indistinguishable from the menu being broken.
Dial-by-extension lives behind option 3 for exactly this reason. If you add
menu options, keep them single-digit.

To change destinations, edit the `exten => 1,1,...` lines in `[ivr-main]`.

### Ring groups

Defined in `config/users.json`, rendered into `[ring-groups]`:

```json
"ringGroups": {
  "reception": { "description": "Main line", "strategy": "ringall", "timeout": 25 }
}
```

Membership comes from each user's `groups` array. Two strategies:

- `ringall` — everyone's phone rings at once, first to answer wins
- `sequential` — one at a time, moving on after `timeout` seconds each

Unanswered groups fall through to the shared `no-answer` tail, which takes a
message on the operator's mailbox. An empty group goes there too, rather than
answering and hanging up.

### Queues

For anything where callers should wait in line with hold music rather than
ring out:

```json
"queues": {
  "sales": {
    "strategy": "rrmemory",
    "timeout": 20,
    "wrapuptime": 10,
    "musicClass": "queue-hold",
    "announceFrequency": 60
  }
}
```

Membership comes from each user's `queues` array, with a penalty — lower
penalties are offered calls first, so `penalty: 1` makes someone an overflow
agent rather than a first responder.

Useful strategies: `rrmemory` (round-robin, remembers position), `leastrecent`
(whoever has waited longest), `fewestcalls`, `ringall`.

Callers who wait out `maxWait` (300s) reach voicemail.

Agents pause and resume themselves with `*45`, or from the dashboard.

## Internal

| Dial          | What happens                                            |
| ------------- | ------------------------------------------------------- |
| `1XX`         | Ring that extension, then their voicemail                |
| `0`           | Reception ring group                                     |
| `*97`         | Your own voicemail                                       |
| `*98`         | Voicemail, asking which mailbox                          |
| `*8`          | Pick up a call ringing at reception                      |
| `*8XXX`       | Pick up a call ringing at that extension                 |
| `*XXX`        | Leave a voicemail without ringing them                   |
| `*45`         | Pause / resume yourself in your queues                   |
| `600`         | Echo test                                                |
| `601`         | Read back your caller ID                                 |
| `602`         | Hand the channel to the ARI application                  |

Extensions must be `1XX` — 100 through 199. The dialplan matches them with the
`_1XX` pattern, and `manage-users.mjs` rejects anything outside that range
rather than provisioning an extension nobody can reach. To use a different
range, change both.

Every route into an extension goes through `[internal-dial]`, so
extension-to-extension calls, ring groups, the IVR and dashboard transfers all
behave identically — including the check that refuses to ring an extension that
was never provisioned, instead of ringing into silence for 25 seconds.

## Outbound

Accepted forms:

| Pattern         | Example        |
| --------------- | -------------- |
| `_9X.`          | `915551234567` |
| `_+X.`          | `+15551234567` |
| `_NXXNXXXXXX`   | `5551234567`   |
| `_1NXXNXXXXXX`  | `15551234567`  |
| `_00X.`         | `00441632...`  |

Caller ID is `MAIN_DID` unless the extension has `outboundCallerId` set in
`users.json`, which is rendered into the endpoint as a channel variable.

With `TRUNK_ENABLED=false`, outbound calls hear a "no service" message rather
than failing with silence.

### A note on patterns

Several patterns use `_X.` rather than the more obvious `_.`. A bare dot also
matches Asterisk's special extensions — `i` (invalid), `t` (timeout), `h`
(hangup), `s` (start) — so a hangup would be routed as if it were a dialled
number. Asterisk warns about this at load; the warning is worth heeding.

## Voicemail

Mailboxes are generated from `users.json`, one per extension, in the
`switchboard` context. PINs are generated if not specified — find them in
`config/users.json`.

Voicemail-to-email is configured but needs an MTA the container does not run.
See [DEPLOYMENT.md](DEPLOYMENT.md#voicemail-to-email).

`minsecs` (4s) must stay above `maxsilence` (3s). If silence detection can run
longer than the minimum keep-length, a caller who says nothing leaves a saved
message containing nothing, and somebody has to listen to it to find that out.

## Adding a route

To send a new DID to a specific ring group:

1. Add the DID to `[from-trunk]`:

   ```
   exten => 15559876543,1,NoOp(Support line)
    same => n,Answer()
    same => n,Goto(queues,support,1)
   ```

2. `make reload`
3. Verify: `asterisk -rx "dialplan show from-trunk"`

Test inbound routing without spending trunk minutes by originating a call from
the Asterisk CLI:

```bash
docker compose exec asterisk asterisk -rx \
  "channel originate Local/15559876543@from-trunk application Echo"
```
