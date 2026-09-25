import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = 1420;
const URL = `http://${HOST}:${PORT}/`;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

function getElectronArgs() {
  const args = ["."];
  const isWayland =
    process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";

  if (isWayland) {
    args.unshift("--ozone-platform=x11");
  }

  return args;
}

await waitForVite();

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
