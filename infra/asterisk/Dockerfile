FROM debian:bookworm-slim

# Asterisk 20 LTS from Debian.  Ships res_pjsip, res_http_websocket (SIP over
# WSS for browsers), res_srtp and res_ari — everything the switchboard needs.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        asterisk \
        asterisk-core-sounds-en-gsm \
        asterisk-moh-opsound-gsm \
        gettext-base \
        ca-certificates \
        openssl \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Config templates are mounted at /etc/asterisk/templates and rendered into
# /etc/asterisk on boot, so a `docker compose restart asterisk` picks up edits.
VOLUME ["/var/spool/asterisk", "/var/log/asterisk"]

EXPOSE 5060/udp 5060/tcp 8088/tcp 8089/tcp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["asterisk", "-f", "-vvv"]
