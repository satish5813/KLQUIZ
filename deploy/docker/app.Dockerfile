# KL Entrance Exam portal (Node 22, Express, SQLite). Production dependencies only; runs as "node" on port 8080.
# The database lives on a volume at /data; the root file system can be read-only.
#   docker build -f deploy/docker/app.Dockerfile -t klquiz .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
RUN apk add --no-cache tini
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server server
COPY --chown=node:node public public
COPY --chown=node:node scripts scripts
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
