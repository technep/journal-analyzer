# syntax=docker/dockerfile:1

# Multi-stage build of the journal-analyzer web app (React + Rust/WASM core),
# shipping the built dist/ plus the Python journal-log-analyzer tool.
#
# The final image is a build artifact, not a server. To get the web app out:
#
#   docker build -t journal-analyzer --build-arg REVISION="$(git rev-parse HEAD)" .
#
#   # via the helper entrypoint (mount a destination directory):
#   docker run --rm -v "$PWD/dist-out:/out" journal-analyzer extract
#
#   # or via docker cp:
#   docker create --name tmp journal-analyzer \
#     && docker cp tmp:/dist ./dist-out && docker rm tmp
#
#   # or via BuildKit, straight to disk with no image left behind:
#   docker buildx build --target web --output type=local,dest=./dist-out .
#
# To launch the GUI analyzer tool (Linux host, X11 forwarding):
#   docker run --rm -e DISPLAY="$DISPLAY" \
#     -v /tmp/.X11-unix:/tmp/.X11-unix journal-analyzer analyze

########## Stage 1: Node dependencies ########################################
FROM node:24-bookworm-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

########## Stage 2: WASM engine ##############################################
FROM rust:1-slim-bookworm AS wasm
WORKDIR /app
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# nodejs runs the npm binaryen wasm-opt (an Emscripten JS wrapper, copied from
# the node-deps stage) so the -Oz pass matches local builds; Debian's native
# binaryen is too old to parse wasm-bindgen 0.2.x output.
# Base image tags pin the Debian release; exact apt versions move with point
# releases, so pinning them would break the build.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates nodejs \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown

# wasm-bindgen-cli must match the wasm-bindgen crate version in core/Cargo.lock
# exactly, so extract it from the lockfile and install the official prebuilt
# binary for that version (a cargo install takes ~10 min and can drift).
# The release tarballs publish no checksum — the crates.io checksum covers
# source only — so integrity is pinned by exact version + reproducible URL +
# the version self-check below, and the tarball hash is printed for the record.
COPY core/Cargo.toml core/Cargo.lock ./core/
ARG TARGETARCH
RUN set -eux; \
    VERSION="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[",]/, "", $3); print $3; exit}' core/Cargo.lock)"; \
    case "$TARGETARCH" in \
      amd64) WBG_ARCH=x86_64 ;; \
      arm64) WBG_ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/rustwasm/wasm-bindgen/releases/download/${VERSION}/wasm-bindgen-${VERSION}-${WBG_ARCH}-unknown-linux-musl.tar.gz" -o /tmp/wbg.tar.gz; \
    echo "wasm-bindgen ${VERSION} tarball sha256: $(sha256sum /tmp/wbg.tar.gz | cut -d' ' -f1)"; \
    tar -xzf /tmp/wbg.tar.gz -C /tmp; \
    install -m 0755 "/tmp/wasm-bindgen-${VERSION}-${WBG_ARCH}-unknown-linux-musl/wasm-bindgen" /usr/local/bin/wasm-bindgen; \
    test "$(wasm-bindgen --version | awk '{print $2}')" = "$VERSION"

COPY core/src ./core/src
COPY scripts/build-wasm.sh ./scripts/build-wasm.sh
COPY --from=node-deps /app/node_modules/binaryen ./node_modules/binaryen
# Build strictly from core/src — never from committed core/pkg artifacts.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    bash scripts/build-wasm.sh

########## Stage 3: web build ################################################
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=node-deps /app/node_modules ./node_modules
COPY . .
COPY --from=wasm /app/core/pkg ./core/pkg
RUN npm run build

########## Stage 4: final artifact image #####################################
FROM debian:bookworm-slim
# System python3 + python3-tk: the analyzer is stdlib-only, and Debian's
# python3-tk gives a working tkinter for the system interpreter.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-tk \
 && rm -rf /var/lib/apt/lists/*

COPY docker/entrypoint.sh /usr/local/bin/journal-analyzer-entrypoint
RUN chmod +x /usr/local/bin/journal-analyzer-entrypoint

COPY journal-log-analyzer/ /opt/journal-log-analyzer/
RUN chmod +x /opt/journal-log-analyzer/journal_log_analyzer.py \
 && ln -s /opt/journal-log-analyzer/journal_log_analyzer.py /usr/local/bin/journal-log-analyzer

COPY --from=web /app/dist /dist

ARG REVISION="unknown"
LABEL org.opencontainers.image.title="journal-analyzer" \
      org.opencontainers.image.description="Built web app (/dist) + journal-log-analyzer GUI tool" \
      org.opencontainers.image.source="https://github.com/technep/journal-analyzer" \
      org.opencontainers.image.revision="$REVISION"

ENTRYPOINT ["journal-analyzer-entrypoint"]
CMD ["help"]
