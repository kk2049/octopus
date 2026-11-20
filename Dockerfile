# Octopus bot — container image (runs the bootstrap-v3 composition root, as production does)
FROM node:22-slim AS base

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    git openssh-client \
    sqlite3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# ── Layer 1: dependency install (cached unless package.json/lockfile change) ──
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/bot/package.json packages/bot/
COPY plugins/machines/package.json plugins/machines/
COPY plugins/sessions/package.json plugins/sessions/

RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Rebuild native modules (version-agnostic path)
RUN cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx --yes node-gyp rebuild

# ── Layer 2: source code + build (invalidated on any source change) ──
COPY . .

RUN pnpm build

# Runtime directories for mounted data, Claude credentials and SSH keys.
# The container now starts the bot as root so the main process can chown user
# workspaces and spawn per-session children under isolated UIDs.
RUN mkdir -p /data /home/claude/.claude /home/claude/.ssh && chmod 777 /data /home/claude /home/claude/.claude /home/claude/.ssh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD test -f /tmp/claude-bot-health && \
        test $(($(date +%s) - $(date -d "$(cat /tmp/claude-bot-health)" +%s 2>/dev/null || echo 0))) -lt 120

# Environment
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV CONFIG_PATH=/app/config.yaml

ENTRYPOINT ["node", "--no-turbo-inline-js-wasm-calls", "--import", "tsx", "packages/bot/src/bootstrap-v3.ts"]
