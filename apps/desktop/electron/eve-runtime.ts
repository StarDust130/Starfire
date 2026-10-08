import { existsSync } from "node:fs";

import path from "node:path";

import { pathToFileURL } from "node:url";

/*
 * Starfire's local Eve agent runtime.
 *
 * Eve runs IN-PROCESS here — the same development host `eve dev`
 * starts, without the CLI or its interactive TUI. Starfire owns the
 * lifecycle: started after app ready, stopped on quit.
 */

type EveServerHandle = {
  kind: string;

  appRoot: string;

  url: string;
};

type EveDevelopmentServer = {
  start(): Promise<EveServerHandle>;

  close(): Promise<void>;
};

type EveHostModule = {
  createDevelopmentServer(
    rootDir: string,

    options?: {
      host?: string;

      port?: number;
    },
  ): EveDevelopmentServer;
};

const LOG = "[Starfire Eve]";

let server: EveDevelopmentServer | null = null;

function resolveEveHostModuleUrl(): string {
  const packageJsonPath = require.resolve("eve/package.json");

  const hostModulePath = path.join(
    path.dirname(packageJsonPath),

    "dist",

    "src",

    "internal",

    "nitro",

    "host",

    "start-development-server.js",
  );

  return pathToFileURL(hostModulePath).href;
}

function appRoot(): string {
  return path.resolve(__dirname, "../../..");
}

export async function startEveRuntime(): Promise<void> {
  const root = appRoot();

  if (!existsSync(path.join(root, "agent", "agent.ts"))) {
    console.log(`${LOG} no agent/ at ${root} — runtime not started.`);

    return;
  }

  try {
    const eveHost = (await import(resolveEveHostModuleUrl())) as EveHostModule;

    console.log(`${LOG} starting local agent runtime...`);

    server = eveHost.createDevelopmentServer(root);

    const handle = await server.start();

    console.log(`${LOG} agent runtime ready at ${handle.url}`);
  } catch (error) {
    server = null;

    console.error(
      `${LOG} failed to start:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function stopEveRuntime(): Promise<void> {
  const current = server;

  server = null;

  if (!current) {
    return;
  }

  try {
    await current.close();

    console.log(`${LOG} agent runtime stopped.`);
  } catch (error) {
    console.error(
      `${LOG} failed to stop cleanly:`,
      error instanceof Error ? error.message : error,
    );
  }
}
