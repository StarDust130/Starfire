import { spawn } from "node:child_process";

import { existsSync } from "node:fs";

import { mkdir, stat, writeFile } from "node:fs/promises";

import path from "node:path";

const HOST = "127.0.0.1";

const PORT = 1420;

const URL = `http://${HOST}:${PORT}/`;

const ELECTRON_DIST = "electron-dist";

/*
 * Load apps/desktop/.env (gitignored) into the environment before
 * anything spawns. Shell-exported variables always win over the file.
 */
function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    return;
  }

  try {
    process.loadEnvFile(envPath);

    console.log("[dev] 🔑 loaded apps/desktop/.env");
  } catch (error) {
    console.warn(
      "[dev] ⚠️ could not parse .env:",
      error instanceof Error ? error.message : error,
    );
  }
}

loadEnvFile();

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });

    child.on("error", reject);

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code}.`));
      }
    });
  });
}

const vite = spawn(
  "pnpm",
  ["exec", "vite", "--host", HOST, "--port", String(PORT)],
  {
    stdio: "inherit",
  },
);

async function waitForVite() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(URL);

      if (response.ok || response.status < 500) {
        return;
      }
    } catch {
      // Vite is still starting.
    }

    await sleep(100);
  }

  throw new Error("Vite did not start on port 1420.");
}

async function buildElectron() {
  console.log("[dev] 📦 building workspace packages (contracts)...");

  await run(
    "pnpm",
    ["--filter", "@starfire/contracts", "build"],
    "contracts build",
  );

  console.log("[dev] 📦 compiling electron main + preload...");

  await mkdir(ELECTRON_DIST, { recursive: true });

  await writeFile(
    path.join(ELECTRON_DIST, "package.json"),
    `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
  );

  await run(
    "pnpm",
    ["exec", "tsc", "-p", "tsconfig.electron.json"],
    "electron build",
  );

  await stat(path.join(ELECTRON_DIST, "main.js"));

  await stat(path.join(ELECTRON_DIST, "preload.js"));

  console.log("[dev] ✅ electron main + preload compiled.");
}

function getElectronArgs() {
  const args = [path.join(ELECTRON_DIST, "main.js")];

  const isWayland =
    process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";

  if (isWayland) {
    args.unshift("--ozone-platform=x11");
  }

  return args;
}

try {
  await buildElectron();

  await waitForVite();
} catch (error) {
  console.error("[dev] ❌ startup failed:", error);

  vite.kill("SIGTERM");

  process.exit(1);
}

const electron = spawn("pnpm", ["exec", "electron", ...getElectronArgs()], {
  stdio: "inherit",
  env: {
    ...process.env,
    STARFIRE_DEV_SERVER_URL: URL,
  },
});

function shutdown() {
  vite.kill("SIGTERM");
  electron.kill("SIGTERM");
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);

electron.on("exit", (code) => {
  vite.kill("SIGTERM");
  process.exit(code ?? 0);
});
