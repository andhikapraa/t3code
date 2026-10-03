# Headless T3 Code server for the fork, served behind a reverse proxy.
# Build: docker build -t t3code .
# Run:   docker run -p 3773:3773 -v t3home:/data t3code
# State lives in /data (T3CODE_HOME); projects go under /workspace.

FROM node:24-bookworm AS build
WORKDIR /repo
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://vite.plus | bash
ENV PATH="/root/.local/share/vite-plus/bin:${PATH}"
COPY . .
RUN vp install --filter=t3... --filter=@t3tools/web... --filter=@t3tools/scripts...
# The nightly version selects the web build's nightly branding and channel.
ARG T3CODE_VERSION=""
RUN if [ -n "$T3CODE_VERSION" ]; then node scripts/update-release-package-versions.ts "$T3CODE_VERSION"; fi
RUN vp run --filter t3 build

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
# Pi is the only provider this image carries; its login lives under /root/.pi.
RUN npm install -g @earendil-works/pi-coding-agent && pi --version
# The bundle keeps native packages (node-pty, fff, keyring) external, so the
# server needs the workspace node_modules next to apps/server/dist.
COPY --from=build /repo /opt/t3code
ENV T3CODE_HOME=/data \
  T3CODE_HOST=0.0.0.0 \
  T3CODE_PORT=3773 \
  T3CODE_NO_BROWSER=true
RUN mkdir -p /data /workspace \
  && printf '#!/bin/sh\nexec node /opt/t3code/apps/server/dist/bin.mjs "$@"\n' > /usr/local/bin/t3 \
  && chmod +x /usr/local/bin/t3
WORKDIR /workspace
VOLUME ["/data", "/root/.pi", "/workspace"]
EXPOSE 3773
ENTRYPOINT ["tini", "--", "t3"]
CMD ["serve"]
