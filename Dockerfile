FROM oven/bun:1.4.3 AS bun
FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apk add --no-cache python3 make g++ && bun install --frozen-lockfile
COPY . .
RUN bun run build && bun run test

FROM build AS check
RUN apk add --no-cache ffmpeg chromaprint && node scripts/native-smoke.cjs

FROM node:24.21.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 PSB_DATA_DIR=/data
RUN apk add --no-cache ffmpeg chromaprint \
	&& mkdir -p /data /tmp/psb \
	&& chown -R node:node /data /tmp/psb
COPY --from=build --chown=node:node /app/package.json /app/
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/dist /app/dist
COPY --from=build --chown=node:node /app/scripts /app/scripts
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
