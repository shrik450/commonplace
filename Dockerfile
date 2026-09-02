# Pinned, not latest. A build that changes its own runtime between two
# deploys is not reproducible.
FROM oven/bun:1.4.0-debian

# single-file-cli drives a real browser to capture a page. Debian's Chromium
# is that browser. Without it every capture fails with ACQUIRE_TOOL_MISSING.
# PUPPETEER_SKIP_DOWNLOAD stops the install from fetching a second Chromium
# that this image would never run. chromium-sandbox is a recommended package,
# not a required one, so --no-install-recommends drops it. single-file-cli
# launches the browser with its sandbox on, and without that setuid helper
# the browser exits and every capture fails.
# The app passes config.browser_path to single-file-cli, so the config you
# mount must set browser_path = "/usr/bin/chromium".
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      chromium \
      chromium-sandbox \
      ca-certificates \
      fonts-liberation \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source edit does not reinstall them.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run css

# The database and the captured files live here. Mount them, or a redeploy
# takes the whole archive with it.
RUN mkdir -p /data/db /data/items /home/bun/.config/commonplace \
 && chown -R bun:bun /data /home/bun/.config /app
VOLUME ["/data/db", "/data/items"]

# The app reads $HOME/.config/commonplace/config.toml, so mount your config
# file at /home/bun/.config/commonplace/config.toml. Do not move
# XDG_CONFIG_HOME to point at it: Chromium writes its profile under the same
# variable, and a read-only mount there stops every capture.

# oven/bun ships this user. The app never needs root.
USER bun

# single-file-cli installs its binary here. `bun run <file>` does not add
# node_modules/.bin to PATH the way a package.json script does, and capture
# resolves the binary through PATH, so name it here or every capture fails
# with ACQUIRE_TOOL_MISSING.
ENV PATH=/app/node_modules/.bin:$PATH

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/health || exit 1

# The web server, not the CLI. It serves the pages and drains the queue in
# one process.
CMD ["bun", "run", "src/web/server.ts"]
