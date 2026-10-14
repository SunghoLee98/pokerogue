# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 SunghoLee98
#
# SPDX-License-Identifier: AGPL-3.0-only

# The co-op relay server (`coop-server/`) for Railway.

FROM node:24.9-alpine

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

COPY coop-server/package.json coop-server/pnpm-lock.yaml coop-server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY coop-server/src ./src

ENV PORT=8787
EXPOSE 8787

CMD ["node", "src/main.ts"]
