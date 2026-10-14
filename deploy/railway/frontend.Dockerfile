# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 SunghoLee98
#
# SPDX-License-Identifier: AGPL-3.0-only

# Production build of the game for Railway: the Vite bundle plus the assets
# submodule, served as static files. The repository clone Railway builds from
# has no submodules, so this fetches them at the commits the repo pins.

ARG NODE_VERSION=24.9

FROM node:${NODE_VERSION}-alpine AS builder

RUN apk add --no-cache git && corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

# Keep these in sync with `git submodule status`.
ARG ASSETS_REF=9378069914157ea599308ef53ff972459276d3e8
ARG LOCALES_REF=7c246744e159b3744a817a2811ec7fee74a43590

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN LEFTHOOK=0 pnpm install --frozen-lockfile

COPY . .

RUN rm -rf assets locales \
  && for pair in "assets pokerogue-assets ${ASSETS_REF}" "locales pokerogue-locales ${LOCALES_REF}"; do \
    set -- $pair; \
    git init -q "$1" \
    && git -C "$1" fetch -q --depth 1 "https://github.com/pagefaultgames/$2.git" "$3" \
    && git -C "$1" checkout -q FETCH_HEAD \
    && rm -rf "$1/.git" || exit 1; \
  done

# Railway passes service variables to the build as build args.
ARG VITE_SERVER_URL
ARG VITE_COOP_RELAY_URL
ENV VITE_SERVER_URL=${VITE_SERVER_URL} \
    VITE_COOP_RELAY_URL=${VITE_COOP_RELAY_URL} \
    VITE_BYPASS_LOGIN=0 \
    VITE_BYPASS_TUTORIAL=0

RUN pnpm build && cp -r assets/. dist/

FROM nginx:1.29-alpine

COPY deploy/railway/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
