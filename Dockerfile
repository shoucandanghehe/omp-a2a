# Standalone omp-a2a hub (no omp runtime inside).
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app

# Install deps first for better layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV NODE_ENV=production \
	OMP_A2A_HUB_PORT=4173 \
	OMP_A2A_HUB_HOST=0.0.0.0 \
	OMP_A2A_HUB_PUBLIC_URL=http://127.0.0.1:4173 \
	OMP_A2A_HUB_DATA_DIR=/data/omp-a2a

# Persist Project metadata, append-only message history, and runtime metadata.
RUN mkdir -p /data/omp-a2a && chown -R bun:bun /data /app
USER bun

EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
	CMD bun -e "fetch('http://127.0.0.1:'+(process.env.OMP_A2A_HUB_PORT||'4173')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/hub/cli.ts"]
