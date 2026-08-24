# Standalone omp-a2a hub (no omp runtime inside).
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb

WORKDIR /app

# Install deps first for better layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV NODE_ENV=production

# Persist Project metadata and append-only message history.
RUN mkdir -p /data/omp-a2a && chown -R bun:bun /data /app
USER bun

EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
	CMD bun -e "fetch('http://127.0.0.1:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/hub/cli.ts", "--host", "0.0.0.0", "--port", "4173", "--data-dir", "/data/omp-a2a"]
