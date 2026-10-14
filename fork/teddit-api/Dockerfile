# Teddit-compatible API sidecar. No npm dependencies: Node's built-in
# http and fetch only.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY vendor ./vendor

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["src/server.js"]
