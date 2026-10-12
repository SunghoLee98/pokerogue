// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

import { startRelayServer } from "./relay-server.ts";

const port = Number(process.env.PORT ?? 8787);
// Listen on all interfaces by default so players on the same LAN can connect.
const host = process.env.HOST ?? "0.0.0.0";

const server = await startRelayServer({ port, host });
console.log(`coop relay listening on ${host}:${server.port}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
