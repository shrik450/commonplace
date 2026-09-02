# Pin the runtime so repeated builds use the same Bun version.
FROM oven/bun:1.4.0-debian

# Install Chromium for `single-file-cli`. Skip Puppeteer's browser download so
# the image contains only one Chromium installation. Install `chromium-sandbox`
# explicitly because `--no-install-recommends` would otherwise omit it.
# Set `browser_path = "/usr/bin/chromium"` in the mounted config.
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

# Copy dependency files first so source changes can reuse the install layer.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run css

# Mount these volumes to preserve the database and captured files across
# container replacements.
RUN mkdir -p /data/db /data/items /home/bun/.config/commonplace \
 && chown -R bun:bun /data /home/bun/.config /app
VOLUME ["/data/db", "/data/items"]

# Mount the config at `/home/bun/.config/commonplace/config.toml`. Don't change
# `XDG_CONFIG_HOME` to the file's mount point because Chromium also writes its
# profile under that directory.

# Run as the unprivileged user from the `oven/bun` image.
USER bun

# Add the `single-file` executable to `PATH`. Direct `bun run <file>` commands
# don't add `node_modules/.bin` automatically.
ENV PATH=/app/node_modules/.bin:$PATH

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/health || exit 1

# Start the web server, which also processes the ingest queue.
CMD ["bun", "run", "src/web/server.ts"]
