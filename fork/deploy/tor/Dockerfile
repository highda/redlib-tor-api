# Minimal Tor SOCKS proxy for Redlib's outbound Reddit traffic.
FROM alpine:3.22

RUN apk add --no-cache tor curl \
	&& mkdir -p /var/lib/tor \
	&& chown -R tor:nogroup /var/lib/tor \
	&& chmod 700 /var/lib/tor

COPY torrc /etc/tor/torrc

USER tor
EXPOSE 9050

# Healthy once Reddit is reachable through Tor. By default this is Reddit's
# onion service: the check also keeps its rendezvous circuit warm (see torrc).
# Set TOR_HEALTHCHECK_URL to a clearnet URL when REDLIB_USE_REDDIT_ONION=off.
ENV TOR_HEALTHCHECK_URL=https://www.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion/robots.txt
HEALTHCHECK --interval=30s --timeout=60s --start-period=180s --retries=5 \
	CMD curl -sf -o /dev/null --max-time 55 --socks5-hostname 127.0.0.1:9050 "$TOR_HEALTHCHECK_URL"

ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
