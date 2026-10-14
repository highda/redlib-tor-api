# Minimal Tor SOCKS proxy for Redlib's outbound Reddit traffic.
FROM alpine:3.22

RUN apk add --no-cache tor curl \
	&& mkdir -p /var/lib/tor \
	&& chown -R tor:nogroup /var/lib/tor \
	&& chmod 700 /var/lib/tor

COPY torrc /etc/tor/torrc

USER tor
EXPOSE 9050

# Healthy once Tor has a circuit and can reach the outside through SOCKS.
HEALTHCHECK --interval=30s --timeout=20s --start-period=60s --retries=5 \
	CMD curl -sf --max-time 15 --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/api/ip | grep -q '"IsTor":true'

ENTRYPOINT ["tor", "-f", "/etc/tor/torrc"]
