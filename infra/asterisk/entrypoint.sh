#!/bin/sh
# ---------------------------------------------------------------------------
# Render the Asterisk configuration from the mounted templates and start it.
#
# Templates live read-only at /etc/asterisk/templates so that editing a file on
# the host and running `docker compose restart asterisk` is enough to pick up a
# change.  Only the files that genuinely need substitution are passed through
# envsubst, and each of those names the variables it expects — otherwise
# envsubst would happily eat Asterisk's own ${EXTEN} style dialplan variables.
# ---------------------------------------------------------------------------
set -eu

TEMPLATES=/etc/asterisk/templates
TARGET=/etc/asterisk
KEYS=/etc/asterisk/keys

log() { printf '[entrypoint] %s\n' "$*" >&2; }

if [ ! -d "$TEMPLATES" ]; then
    log "FATAL: $TEMPLATES is not mounted; nothing to render."
    exit 1
fi

# --- Derived values --------------------------------------------------------
# Asterisk needs the public address in the SDP it hands to browsers, otherwise
# the far end tries to send RTP to a container-private 172.x address.
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-localhost}"
ASTERISK_SIP_DOMAIN="${ASTERISK_SIP_DOMAIN:-$PUBLIC_HOSTNAME}"

# `localhost` is never a useful external address, so leave the NAT settings out
# entirely for local development rather than writing a bogus one.
if [ "$PUBLIC_HOSTNAME" = "localhost" ] || [ "$PUBLIC_HOSTNAME" = "127.0.0.1" ]; then
    EXTERNAL_MEDIA_LINE=";  external_media_address not set (local development)"
    EXTERNAL_SIGNALING_LINE=";  external_signaling_address not set (local development)"
else
    EXTERNAL_MEDIA_LINE="external_media_address=${PUBLIC_HOSTNAME}"
    EXTERNAL_SIGNALING_LINE="external_signaling_address=${PUBLIC_HOSTNAME}"
fi
export EXTERNAL_MEDIA_LINE EXTERNAL_SIGNALING_LINE PUBLIC_HOSTNAME ASTERISK_SIP_DOMAIN

# The dialplan needs a plain yes/no it can compare against, because
# GotoIf cannot see the container's environment.
if [ "${TRUNK_ENABLED:-false}" = "true" ]; then
    TRUNK_CONFIGURED=yes
else
    TRUNK_CONFIGURED=no
fi
export TRUNK_CONFIGURED
export OPERATOR_EXTENSION="${OPERATOR_EXTENSION:-100}"
export IVR_ENABLED="${IVR_ENABLED:-false}"
export OFFICE_HOURS="${OFFICE_HOURS:-*,*,*,*}"

# --- TLS -------------------------------------------------------------------
# Browsers will not open a WebSocket to an endpoint whose certificate they do
# not trust, so a missing cert is a hard stop rather than a warning: Asterisk
# would otherwise boot happily with WSS silently disabled.
if [ ! -f "$KEYS/asterisk.pem" ] || [ ! -f "$KEYS/asterisk.key" ]; then
    log "FATAL: certificate or key missing from $KEYS."
    log "       Run ./scripts/generate-dev-certs.sh (development) or install"
    log "       your real certificate as infra/certs/asterisk.pem plus"
    log "       infra/certs/asterisk.key."
    exit 1
fi

# The host's key is mode 0600 and owned by whoever generated it, but Asterisk
# drops to the `asterisk` user before opening it — so reading it straight from
# the read-only mount fails with a bare "Permission denied" from OpenSSL and
# TLS quietly stays off.  Copy it somewhere this container owns instead.
PRIVATE_KEYS=/var/lib/asterisk/keys
mkdir -p "$PRIVATE_KEYS"
cp "$KEYS/asterisk.pem" "$PRIVATE_KEYS/asterisk.pem"
cp "$KEYS/asterisk.key" "$PRIVATE_KEYS/asterisk.key"
chown asterisk:asterisk "$PRIVATE_KEYS/asterisk.pem" "$PRIVATE_KEYS/asterisk.key"
chmod 0400 "$PRIVATE_KEYS/asterisk.key"
chmod 0444 "$PRIVATE_KEYS/asterisk.pem"

# --- Render ----------------------------------------------------------------
render() {
    src="$TEMPLATES/$1"
    dst="$TARGET/$1"
    vars="$2"
    if [ ! -f "$src" ]; then
        log "skip $1 (no template)"
        return 0
    fi
    if [ -n "$vars" ]; then
        envsubst "$vars" <"$src" >"$dst"
    else
        cp "$src" "$dst"
    fi
}

log "rendering configuration for ${PUBLIC_HOSTNAME}"

render asterisk.conf      ''
render modules.conf       ''
render logger.conf        ''
render musiconhold.conf   ''
render queues.conf        ''
render http.conf          '${PUBLIC_HOSTNAME}'
render rtp.conf           '${RTP_START} ${RTP_END}'
render ari.conf           '${ARI_USERNAME} ${ARI_PASSWORD}'
render manager.conf       '${AMI_USERNAME} ${AMI_PASSWORD}'
render pjsip.conf         '${PUBLIC_HOSTNAME} ${ASTERISK_SIP_DOMAIN} ${EXTERNAL_MEDIA_LINE} ${EXTERNAL_SIGNALING_LINE} ${TRUNK_NAME} ${TRUNK_HOST} ${TRUNK_PORT} ${TRUNK_TRANSPORT} ${TRUNK_USERNAME} ${TRUNK_PASSWORD} ${TRUNK_FROM_USER} ${TRUNK_FROM_DOMAIN}'
render extensions.conf    '${MAIN_DID} ${MAIN_CALLER_ID_NAME} ${TRUNK_NAME} ${TRUNK_CONFIGURED} ${ARI_APP} ${OPERATOR_EXTENSION} ${IVR_ENABLED} ${OFFICE_HOURS}'
render voicemail.conf     '${MAIN_CALLER_ID_NAME}'

# The per-user files are generated on the host by scripts/manage-users.mjs from
# config/users.json.  They are optional so that a fresh checkout still boots.
for generated in pjsip_endpoints.conf extensions_users.conf extensions_did.conf voicemail_users.conf queues_members.conf; do
    if [ -f "$TEMPLATES/$generated" ]; then
        cp "$TEMPLATES/$generated" "$TARGET/$generated"
    else
        log "no $generated yet — writing an empty stub"
        printf '; generated by scripts/manage-users.mjs — no users defined yet\n' >"$TARGET/$generated"
    fi
done

# --- Trunk -----------------------------------------------------------------
# The trunk is a separate include so that the whole block can be dropped when
# TRUNK_ENABLED=false; a half-configured trunk makes Asterisk retry a
# registration against a nonexistent host every 60s and floods the log.
TRUNK_ENABLED="${TRUNK_ENABLED:-false}"
if [ "$TRUNK_ENABLED" = "true" ]; then
    if [ -z "${TRUNK_HOST:-}" ]; then
        log "FATAL: TRUNK_ENABLED=true but TRUNK_HOST is empty."
        exit 1
    fi
    log "trunk '${TRUNK_NAME:-primary}' -> ${TRUNK_HOST} (${TRUNK_AUTH:-userpass})"
    if [ "${TRUNK_AUTH:-userpass}" = "ip" ]; then
        # An IP-authenticated trunk must not register and must not send digest
        # credentials; the provider identifies us by source address.  The
        # endpoint's outbound_auth line goes too, along with the section it
        # would have pointed at.
        sed -e '/^;;IPAUTH;;/d' \
            -e '/^;;AUTHLINE;;/d' \
            -e '/^;;USERPASS;;/,/^;;ENDUSERPASS;;/d' \
            "$TARGET/pjsip.conf" >"$TARGET/pjsip.conf.tmp"
    else
        sed -e '/^;;USERPASS;;/d' -e '/^;;ENDUSERPASS;;/d' \
            -e 's/^;;AUTHLINE;;//' \
            -e '/^;;IPAUTH;;/,/^;;ENDIPAUTH;;/d' \
            "$TARGET/pjsip.conf" >"$TARGET/pjsip.conf.tmp"
    fi
    sed -e '/^;;ENDIPAUTH;;/d' "$TARGET/pjsip.conf.tmp" >"$TARGET/pjsip.conf"
    rm -f "$TARGET/pjsip.conf.tmp"
else
    log "trunk disabled — internal extensions only"
    sed -e '/^;;TRUNK;;/,/^;;ENDTRUNK;;/d' "$TARGET/pjsip.conf" >"$TARGET/pjsip.conf.tmp"
    mv "$TARGET/pjsip.conf.tmp" "$TARGET/pjsip.conf"
fi

chown -R asterisk:asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk 2>/dev/null || true
chown asterisk:asterisk "$TARGET"/*.conf 2>/dev/null || true

log "configuration ready; starting Asterisk"
exec "$@"
