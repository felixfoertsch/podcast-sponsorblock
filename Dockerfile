FROM oven/bun:1.4.3-alpine AS bun
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apk add --no-cache bash python3 make g++ && bun install --frozen-lockfile
COPY . .
RUN bun run build && bun run test

FROM build AS check
RUN apk add --no-cache ffmpeg=8.1.3-r0 chromaprint=1.6.0-r0 && node scripts/native-smoke.cjs && node --import tsx --test tests/analysis-e2e.test.ts

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 PSB_DATA_DIR=/data
RUN apk add --no-cache ffmpeg=8.1.3-r0 chromaprint=1.6.0-r0 \
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
