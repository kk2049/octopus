# The CI environment, made persistent (ticket #219).
#
# Same base image and the same Node pin as `.gitlab-ci.yml`'s `full_suite`, on
# purpose: a repair agent that gets a green here has to be able to believe the
# next batch will agree. Anything this image and that job disagree about is a
# way for the agent to be misled, so the recipe below is a copy of that job's
# `before_script`, not an improvement on it.
#
# What is different is lifetime. CI jobs get an ephemeral container and a cold
# `pnpm install` every time; this one stays up, keeps `node_modules`, the pnpm
# store and the Playwright browsers warm, and runs the octopus Runner so an
# agent can reach it. That is the whole point: the loop has to be fast enough
# that a repair agent verifies instead of guessing.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Keep the persistent CI machine byte-for-byte aligned with production and the
# full GitLab suite. App sandboxes use the stable `--permission` spelling.
ARG NODE_VERSION=22.23.2
ARG PNPM_VERSION=9.15.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      build-essential python3 python3-setuptools libsecret-1-dev sqlite3 git openssh-client jq tmux \
 && tmux -V \
 && rm -rf /var/lib/apt/lists/*

# COREPACK_HOME is pinned to a baked-in path on purpose, and it must NOT sit
# under XDG_CACHE_HOME: the runtime moves that to the /work volume, and a
# corepack home that starts out empty makes `pnpm` silently download "latest"
# instead of the activated pin. Measured on the first build of this image —
# `pnpm --version` reported 11.22.0 where CI runs 9.15.0. The root
# package.json has no `packageManager` field to fall back on, so nothing else
# would have caught it, and "green in the container, red in CI" is the one
# failure mode this container must not have.
ENV COREPACK_HOME=/opt/corepack
RUN npm install -g n \
 && n "$NODE_VERSION" \
 && hash -r \
 && test "$(node --version)" = "v$NODE_VERSION" \
 && corepack enable \
 && corepack prepare "pnpm@$PNPM_VERSION" --activate \
 && test "$(pnpm --version)" = "$PNPM_VERSION"

# Everything mutable lives under /work, which is a volume on /mnt/disk: this
# host's root filesystem is 95% full and a warm checkout plus a pnpm store is
# tens of gigabytes.
ENV OCTOPUS_WORK=/work \
    OCTOPUS_CHECKOUT=/work/octopus \
    PNPM_STORE_DIR=/work/pnpm-store \
    XDG_CACHE_HOME=/work/cache \
    NODE_VERSION_PIN=$NODE_VERSION \
    PNPM_VERSION_PIN=$PNPM_VERSION \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # The Runner's workspace registry and agent-runtime state hang off this,
    # NOT off $HOME: the container's home is not on the volume, so a default
    # here would silently drop the registered checkout on every recreate.
    # Baked into the image rather than only into `docker run` so a hand-started
    # container behaves the same as an installed one.
    RUNNER_SCAN_HOME=/work \
    # The runner is an investigation + machine endpoint here, not a laptop:
    # nothing installs Claude Code / Codex hooks into this container.
    RUNNER_AGENT_HOOKS=manual
WORKDIR /work

COPY entrypoint.sh /usr/local/bin/octopus-ci-entrypoint
RUN chmod 0755 /usr/local/bin/octopus-ci-entrypoint

ENTRYPOINT ["/usr/local/bin/octopus-ci-entrypoint"]
