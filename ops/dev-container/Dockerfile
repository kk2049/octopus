# A contributor's development container (2026-08-20).
#
# The CI environment, on a laptop: same base image, same Node pin and the same
# pnpm as `.gitlab-ci.yml`'s `full_suite` and `ops/ci-container/Dockerfile`,
# for the same reason — a contributor who sees green here has to be able to
# believe the complete CI run on their proposal will agree.
#
# What differs from the CI container:
#   · it never holds a repository credential. Code arrives as git bundles the
#     bot pipeline hands over through one-shot URLs (`devpipe/bundle-handoff.ts`)
#     and the container downloads through its Runner; nothing in here can push;
#   · the Runner is the pre-built standalone bundle downloaded from the
#     dashboard with the device token, so the container is useful before any
#     checkout exists;
#   · Codex CLI is installed so the contributor can run THEIR OWN agent here
#     through Sessions+ (`codex login` is theirs to do; the image ships no
#     model credential).
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ARG NODE_VERSION=22.23.2
ARG PNPM_VERSION=9.15.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential python3 python3-setuptools libsecret-1-dev sqlite3 git curl ca-certificates jq tmux \
 && rm -rf /var/lib/apt/lists/*

# See ops/ci-container/Dockerfile for why COREPACK_HOME is a baked-in path.
ENV COREPACK_HOME=/opt/corepack
RUN npm install -g n \
 && n "$NODE_VERSION" \
 && hash -r \
 && test "$(node --version)" = "v$NODE_VERSION" \
 && corepack enable \
 && corepack prepare "pnpm@$PNPM_VERSION" --activate \
 && test "$(pnpm --version)" = "$PNPM_VERSION" \
 && npm install -g @openai/codex || echo "codex CLI install skipped (offline?)"

ENV OCTOPUS_WORK=/work \
    OCTOPUS_CHECKOUT=/work/octopus \
    PNPM_STORE_DIR=/work/pnpm-store \
    XDG_CACHE_HOME=/work/cache \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    RUNNER_SCAN_HOME=/work \
    RUNNER_AGENT_HOOKS=manual \
    HOME=/work/home
WORKDIR /work

COPY entrypoint.sh /usr/local/bin/octopus-dev-entrypoint
RUN chmod 0755 /usr/local/bin/octopus-dev-entrypoint

ENTRYPOINT ["/usr/local/bin/octopus-dev-entrypoint"]
