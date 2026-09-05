# Commonplace tasks.
#
# This repository builds its own image, because it owns the Dockerfile, the
# version in package.json, and the gate that says the tree is good. It knows
# nothing about where the image runs. Shipping it to a machine is a separate
# job and lives with that machine's config.

image := "localhost/commonplace"
source_url := "https://github.com/shrik450/commonplace"

# List the tasks.
default:
    @just --list

# Print the reference `just build` produces.
ref:
    @echo "{{ image }}:$(bun -p 'require("./package.json").version')"

# Type check, lint, and test. The project's definition of done.
verify:
    bun run verify

# A dirty tree makes the revision label a lie, and that label is the only
# record of which commit a running container came from. This runs before the
# tests, so the cheap check fails first.

# Refuse a checkout with uncommitted changes.
clean-tree:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "This checkout has uncommitted changes. Commit them first, or the" >&2
      echo "revision label would name a commit that is not what got built." >&2
      exit 1
    fi

# Build the container image from a clean checkout.
build: clean-tree verify
    #!/usr/bin/env bash
    set -euo pipefail

    version="$(bun -p 'require("./package.json").version')"
    if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
      echo "package.json must hold a semantic version with no build metadata," >&2
      echo "got: $version" >&2
      exit 1
    fi
    sha="$(git rev-parse HEAD)"

    # Every OCI label oven/bun sets describes oven/bun, and an inherited label
    # reads as a valid answer to the wrong question. Override all of them,
    # rather than only the ones with a reader today, so there is one rule and
    # not a list of exceptions.
    podman build \
      --label "org.opencontainers.image.title=commonplace" \
      --label "org.opencontainers.image.description=Reading archive" \
      --label "org.opencontainers.image.url={{ source_url }}" \
      --label "org.opencontainers.image.source={{ source_url }}" \
      --label "org.opencontainers.image.version=$version" \
      --label "org.opencontainers.image.revision=$sha" \
      --label "org.opencontainers.image.licenses=NONE" \
      --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --tag "{{ image }}:$version" \
      --tag "{{ image }}:$sha" \
      .

    echo
    echo "Built {{ image }}:$version, also named {{ image }}:$sha"
