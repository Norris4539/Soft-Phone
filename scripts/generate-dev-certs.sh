#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Self-signed certificate for local development.
#
# Browsers refuse a WebSocket to an untrusted certificate, and unlike a normal
# page there is no "proceed anyway" prompt on a WSS handshake — the connection
# just fails.  So after running this you must visit the Asterisk TLS port once
# in the browser and accept the certificate manually:
#
#     https://localhost:8089/httpstatus
#
# For production, drop your real certificate in as infra/certs/asterisk.pem
# and the key as infra/certs/asterisk.key instead of running this.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/infra/certs"
HOSTNAME_ARG="${1:-${PUBLIC_HOSTNAME:-localhost}}"
DAYS=825

mkdir -p "$CERT_DIR"

if [[ -f "$CERT_DIR/asterisk.pem" && "${FORCE:-0}" != "1" ]]; then
    echo "Certificate already exists at $CERT_DIR/asterisk.pem"
    echo "Re-run with FORCE=1 to replace it."
    exit 0
fi

echo "Generating a self-signed certificate for '$HOSTNAME_ARG' (${DAYS} days)..."

# A SAN is mandatory: every current browser ignores the legacy CN field, so a
# CN-only certificate fails validation no matter what it says.
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/asterisk.key" \
    -out "$CERT_DIR/asterisk.pem" \
    -days "$DAYS" \
    -subj "/CN=$HOSTNAME_ARG/O=Softphone Switchboard/OU=Development" \
    -addext "subjectAltName=DNS:$HOSTNAME_ARG,DNS:localhost,IP:127.0.0.1" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" \
    2>/dev/null

chmod 600 "$CERT_DIR/asterisk.key"
chmod 644 "$CERT_DIR/asterisk.pem"

echo
echo "Wrote:"
echo "  $CERT_DIR/asterisk.pem"
echo "  $CERT_DIR/asterisk.key"
echo
echo "Next: start the stack, then open https://$HOSTNAME_ARG:8089/httpstatus"
echo "in the browser you will use the softphone from, and accept the warning."
echo "Until you do, SIP registration over WSS will fail with no visible error."
