# Asterisk setup for the phone agent

The app does not speak SIP. Asterisk does, and hands us clean audio over a TCP
socket. This file is the Asterisk side of that arrangement.

## Why Asterisk rather than a SIP stack in Node

Asterisk handles SIP registration, RTP, NAT traversal, DTMF, jitter and codec
negotiation with the trunk — and, critically, **transcodes the trunk's G.711 to
16 kHz linear PCM**. That last part is the whole design:

```
trunk (G.711 A-law, 8 kHz)
  → Asterisk transcodes → slin16 (16 kHz linear)
  → AudioSocket → our app → Gemini Live   ← wants exactly 16 kHz linear
```

So the **inbound path needs no conversion at all**, and the outbound path needs
one fixed 3:2 downsample (Gemini speaks at 24 kHz). Writing a SIP stack and an
RTP jitter buffer in Node would be weeks of work to arrive somewhere worse.

## Requirements

- Asterisk 18+ (ARI `externalMedia` with `encapsulation=audiosocket` needs 18)
- The app reachable from Asterisk on `AUDIOSOCKET_PORT` (same host is simplest)
- **The trunk MUST offer G.711** (`alaw` in Pakistan, `ulaw` in North America).
  Many PK providers default to **G.729**, which is licensed and Asterisk will not
  transcode out of the box. Agree G.711 with the provider before anything else —
  this is the single most likely reason a new trunk produces silence.

## `pjsip.conf`

Replace the placeholders with what the provider gives you.

```ini
[transport-udp]
type = transport
protocol = udp
bind = 0.0.0.0:5060
; Required when Asterisk is behind NAT — without these the provider sends RTP
; to a private address and the call connects with no audio in one direction.
external_media_address = YOUR.PUBLIC.IP
external_signaling_address = YOUR.PUBLIC.IP
local_net = 10.0.0.0/8
local_net = 172.16.0.0/12
local_net = 192.168.0.0/16

[trunk]
type = registration
transport = transport-udp
outbound_auth = trunk-auth
server_uri = sip:sip.provider.pk
client_uri = sip:YOUR_ACCOUNT@sip.provider.pk
retry_interval = 60

[trunk-auth]
type = auth
auth_type = userpass
username = YOUR_ACCOUNT
password = YOUR_PASSWORD

[trunk]
type = aor
contact = sip:sip.provider.pk

[trunk]
type = endpoint
transport = transport-udp
context = from-trunk
; alaw first, and G.729 deliberately absent — see the note above.
disallow = all
allow = alaw
allow = ulaw
outbound_auth = trunk-auth
aors = trunk
; Trust the provider's caller ID, but see the CLI caveat below.
trust_id_inbound = yes
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
direct_media = no

[trunk]
type = identify
endpoint = trunk
match = sip.provider.pk
```

## `extensions.conf`

Every inbound call goes straight to our Stasis application. `${EXTEN}` is the
dialled number, which is what maps the call to a tenant (`channels.phone.didNumber`).

```ini
[from-trunk]
exten => _X.,1,NoOp(Inbound ${CALLERID(num)} -> ${EXTEN})
 same => n,Set(CHANNEL(language)=en)
 ; Do NOT Answer() here — the app answers via ARI, so it only picks up once it
 ; is genuinely ready to speak. Answering early bills the caller for silence.
 same => n,Stasis(echo-agent)
 same => n,Hangup()

; Fallback if the app is down. Without this a caller gets dead air, which is
; worse than a busy tone: they wait, then blame the restaurant.
exten => failed,1,Playback(sorry-cant-let-you-do-that)
 same => n,Hangup()
```

## `ari.conf`

```ini
[general]
enabled = yes
pretty = yes
; ARI carries no transport security of its own and the app sends credentials in
; the WebSocket query string, so this must stay on loopback. If Asterisk and the
; app are on different hosts, put a TLS reverse proxy in front and do NOT expose
; 8088 publicly.
allowed_origins = *

[echo]
type = user
read_only = no
password = CHANGE_ME_LONG_RANDOM
```

## `http.conf`

```ini
[general]
enabled = yes
bindaddr = 127.0.0.1
bindport = 8088
```

## App environment

```
SIP_ENABLED=true
ARI_URL=http://127.0.0.1:8088
ARI_USERNAME=echo
ARI_PASSWORD=CHANGE_ME_LONG_RANDOM
ARI_APP=echo-agent
AUDIOSOCKET_PORT=8090
AUDIOSOCKET_ADDRESS=127.0.0.1:8090
```

`ARI_APP` must match the `Stasis()` argument in the dialplan.

## Tenant configuration

Point a DID at a restaurant:

```bash
npx tsx --env-file=.env scripts/enable-pos.ts --slug <slug> --phone --did "+923001234567"
```

`didNumber` is compared digit-only, so `+92 300 123 4567` and `923001234567`
match. It must be unique across tenants — two restaurants claiming one number
means whichever is scanned first wins, silently.

## Verifying, in order

Each step isolates one layer; do them in sequence rather than debugging the
whole chain at once.

1. **Trunk registered** — `asterisk -rx "pjsip show registrations"` → `Registered`
2. **ARI reachable** — `curl -u echo:PASS http://127.0.0.1:8088/ari/asterisk/info`
3. **App connected** — the log shows `[ARI] connected to … as app "echo-agent"`
   and `[AUDIOSOCKET] listening on 0.0.0.0:8090`
4. **Call arrives** — dial the DID; the log shows `[PHONE] inbound ****1234 → …`
5. **Media leg opens** — `[AUDIOSOCKET] call connected from 127.0.0.1:…`
6. **Agent speaks** — you hear the greeting and the routing question

## Known traps

- **G.729 trunk.** Symptom: the call connects and there is total silence.
  Fix: agree G.711 with the provider.
- **No audio one way.** Almost always NAT. Check `external_media_address` and
  `local_net` in `pjsip.conf`.
- **Media leg never connects.** Asterisk is dialling `AUDIOSOCKET_ADDRESS` and
  cannot reach it. On one host that is `127.0.0.1:8090`; across hosts it must be
  an address Asterisk can actually route to, and the port must be open.
- **No caller ID.** Common on Pakistani trunks. This is expected and handled:
  the prompt tells the agent to ask for a callback number rather than assume one.
- **Asterisk restarts.** The app reconnects with jittered backoff; calls in
  progress are lost, which is unavoidable.

## Running Asterisk separately

Prefer a separate host or container from the app. A Node restart during a deploy
then drops calls in progress rather than taking the whole switch down with it —
and the app's shutdown handler drains active calls before exiting for exactly
this reason.
