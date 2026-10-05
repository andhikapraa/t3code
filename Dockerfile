# Hosted web client for the fork, served at t3.prasetya.dev like app.t3.codes.
# It holds no environment: users sign in to T3 Connect and pick a linked machine.
#
# Build: docker build -t t3code-web .
# Run:   docker run -p 8080:80 t3code-web

FROM node:24-bookworm AS build
WORKDIR /repo
RUN curl -fsSL https://vite.plus | bash
ENV PATH="/root/.local/share/vite-plus/bin:${PATH}"
COPY . .
RUN vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'
# The nightly version selects the web build's nightly branding.
ARG T3CODE_VERSION=""
RUN if [ -n "$T3CODE_VERSION" ]; then node scripts/update-release-package-versions.ts "$T3CODE_VERSION"; fi
# T3 Connect against the fork's relay. The bundle embeds these public values,
# and VITE_HOSTED_APP_URL must equal the serving origin for hosted mode.
ARG T3CODE_CLERK_PUBLISHABLE_KEY=""
ARG T3CODE_CLERK_JWT_TEMPLATE=""
ARG T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=""
ARG T3CODE_RELAY_URL=""
ARG T3CODE_HOSTED_APP_URL=""
ARG T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=""
ARG T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=""
RUN --mount=type=secret,id=relay_client_otlp_token,required=false \
  T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN="$(cat /run/secrets/relay_client_otlp_token 2>/dev/null || true)" \
  VITE_HOSTED_APP_URL="$T3CODE_HOSTED_APP_URL" \
  T3CODE_WEB_SOURCEMAP=0 \
  vp run --filter @t3tools/web build \
  && node scripts/apply-web-brand-assets.ts nightly

FROM nginx:1.29-alpine
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
