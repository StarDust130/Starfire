import { execFile } from "node:child_process";

import { promises as fs } from "node:fs";

import os from "node:os";

import path from "node:path";

export type KwinCommand = {
  action: "focus" | "lower" | "minimize" | "maximize" | "restore";

  /** Lowercased app hint, or null for the ACTIVE window. */
  app: string | null;
};

type KwinOutcome = "ok" | "notfound" | "failed" | "unverified" | "unreachable";

const KWIN_DEST = "org.kde.KWin";

const SCRIPT_NAME = "starfire_windows";

const FEEDBACK_PREFIX = "STARFIRE:";

const FEEDBACK_TIMEOUT_MS = 1500;

function runBinary(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,

      { timeout: 4000 },

      (error, stdout) => {
        if (error) {
          reject(
            new Error(`${command}: ${String(error.message).slice(0, 200)}`),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/*
 * DBus CLI: gdbus ships with glib, qdbus ships with Qt — both are
 * essentially always present on KDE. Whichever works is used.
 */
function makeDbusCall(log?: (message: string) => void) {
  let working: "gdbus" | "qdbus" | null = null;

  return async (args: string[]): Promise<string> => {
    if (working === "gdbus") {
      return runBinary("gdbus", args);
    }

    if (working === "qdbus") {
      return runBinary("qdbus", args);
    }

    try {
      const out = await runBinary("gdbus", args);

      working = "gdbus";

      return out;
    } catch (gdbusError) {
      try {
        const out = await runBinary("qdbus", args);

        working = "qdbus";

        return out;
      } catch (qdbusError) {
        log?.(
          `kwin dbus failed — gdbus: ${String(gdbusError)} | qdbus: ${String(qdbusError)}`,
        );

        throw gdbusError;
      }
    }
  };
}

function dbusArgs(
  objectPath: string,
  method: string,
  extra: string[] = [],
): string[] {
  return [
    "call",
    "--session",
    "--dest",
    KWIN_DEST,
    "--object-path",
    objectPath,
    "--method",
    method,
    ...extra,
  ];
}

/*
 * KWin script (Plasma 5 + 6 compatible): finds the target window and
 * performs the action. The result is reported through Klipper, which
 * Electron reads back and immediately restores.
 */
function buildKwinScript(command: KwinCommand): string {
  const cmd = JSON.stringify(command);

  return `
var STARFIRE_CMD = ${cmd};

var windows = [];
try { windows = workspace.windowList(); } catch (e) {}
if (windows.length === 0) { try { windows = workspace.clientList(); } catch (e) {} }

function norm(s) { return String(s || "").toLowerCase(); }

var target = null;
var i;
var w;

for (i = 0; i < windows.length; i++) {
    w = windows[i];
    if (w.managed === false) { continue; }
    if (norm(w.resourceClass) === "starfire") { continue; }

    if (STARFIRE_CMD.app) {
        if (norm(w.resourceClass).indexOf(STARFIRE_CMD.app) !== -1 ||
            norm(w.caption).indexOf(STARFIRE_CMD.app) !== -1) {
            target = w;
            break;
        }
    } else {
        var isActive =
            (typeof workspace.activeWindow !== "undefined" && w === workspace.activeWindow) ||
            (typeof workspace.activeClient !== "undefined" && w === workspace.activeClient);
        if (isActive) { target = w; break; }
    }
}

var outcome = "STARFIRE:NOTFOUND";

if (target) {
    var ok = true;
    try {
        if (STARFIRE_CMD.action === "minimize") {
            target.minimized = true;
        } else if (STARFIRE_CMD.action === "restore") {
            target.minimized = false;
            if ("activeWindow" in workspace) { workspace.activeWindow = target; }
            else { workspace.activeClient = target; }
        } else if (STARFIRE_CMD.action === "focus") {
            target.minimized = false;
            if ("activeWindow" in workspace) { workspace.activeWindow = target; }
            else { workspace.activeClient = target; }
        } else if (STARFIRE_CMD.action === "maximize") {
            if (typeof target.setMaximize === "function") { target.setMaximize(true, true); }
            else if (typeof target.quickMaximize === "function") { target.quickMaximize(); }
            else { ok = false; }
        } else if (STARFIRE_CMD.action === "lower") {
            if (typeof target.lower === "function") { target.lower(); }
            else { ok = false; }
        } else {
            ok = false;
        }
    } catch (e) { ok = false; }

    outcome = ok ? "STARFIRE:OK" : "STARFIRE:FAILED";
}

try {
    callDBus(
        "org.kde.klipper",
        "/klipper",
        "org.kde.klipper.klipper",
        "setClipboardContents",
        outcome
    );
} catch (e) {}
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/*
 * Load -> run -> unload. KWin exposes the script object at different
 * paths / interface names across Plasma versions, so run() is
 * attempted on every known combination.
 */
async function loadAndRun(
  dbus: (args: string[]) => Promise<string>,
  scriptPath: string,
  log?: (message: string) => void,
): Promise<void> {
  const loaded = await dbus(
    dbusArgs("/Scripting", "org.kde.kwin.Scripting.loadScript", [
      scriptPath,
      SCRIPT_NAME,
    ]),
  );

  const idMatch = loaded.match(/(\d+)/);

  if (!idMatch?.[1]) {
    throw new Error(`loadScript returned no id: ${loaded.slice(0, 100)}`);
  }

  const id = idMatch[1];

  const attempts: Array<{ objectPath: string; method: string }> = [
    { objectPath: `/Scripting/Script${id}`, method: "org.kde.kwin.Script.run" },
    {
      objectPath: `/Scripting/Script${id}`,
      method: "org.kde.kwin.Scripting.run",
    },
    { objectPath: `/${id}`, method: "org.kde.kwin.Script.run" },
    {
      objectPath: `/Scripting/Script${id}`,
      method: "org.kde.kwin.Scripting.run",
    },
  ];

  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      await dbus(dbusArgs(attempt.objectPath, attempt.method));

      return;
    } catch (error) {
      lastError = error;
    }
  }

  log?.(`kwin run failed on all paths: ${String(lastError)}`);

  throw lastError ?? new Error("could not run the KWin script");
}

async function executeKwinCommand(
  dbus: (args: string[]) => Promise<string>,
  command: KwinCommand,
): Promise<KwinOutcome> {
  const scriptPath = path.join(
    os.tmpdir(),

    `starfire-kwin-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
  );

  await fs.writeFile(scriptPath, buildKwinScript(command), "utf8");

  try {
    await loadAndRun(dbus, scriptPath);
  } catch {
    return "unreachable";
  } finally {
    try {
      await dbus(
        dbusArgs("/Scripting", "org.kde.kwin.Scripting.unloadScript", [
          SCRIPT_NAME,
        ]),
      );
    } catch {
      // already unloaded, or never loaded
    }

    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }

  return "unverified";
}

export type KwinWindowController = {
  /**
   * Performs the action and returns whether it demonstrably worked.
   * "unverified" (no Klipper) still counts as done: the script ran
   * without errors.
   */
  perform(
    action: KwinCommand["action"],
    app: string | null,
  ): Promise<{ done: boolean; detail?: string }>;
};

/*
 * Clipboard IO is accepted as sync OR async, because Electron
 * typings for clipboard.readText vary between environments.
 */
export type KwinClipboardIO = {
  read(): string | Promise<string>;

  write(text: string): void;
};

export function createKwinWindowController(
  io: KwinClipboardIO,
  log?: (message: string) => void,
): KwinWindowController {
  const dbus = makeDbusCall(log);

  return {
    async perform(action, app) {
      const previousClipboard = await io.read();

      let outcome: KwinOutcome;

      try {
        outcome = await executeKwinCommand(dbus, { action, app });
      } catch {
        return {
          done: false,

          detail: "I couldn't reach KWin to control windows right now.",
        };
      }

      if (outcome === "unreachable") {
        return {
          done: false,

          detail: "I couldn't reach KWin to control windows right now.",
        };
      }

      if (outcome === "unverified") {
        /*
         * Poll for the Klipper feedback token; restore the user's
         * clipboard no matter what.
         */
        const deadline = Date.now() + FEEDBACK_TIMEOUT_MS;

        while (Date.now() < deadline) {
          await sleep(80);

          const text = await io.read();

          if (text.startsWith(FEEDBACK_PREFIX)) {
            io.write(previousClipboard);

            if (text === "STARFIRE:OK") {
              return { done: true };
            }

            if (text === "STARFIRE:NOTFOUND") {
              return {
                done: false,

                detail: "I couldn't find that window — is it open?",
              };
            }

            return {
              done: false,

              detail: "The window action didn't work.",
            };
          }
        }

        /*
         * No Klipper: the script itself ran cleanly, so trust it.
         */
        return { done: true };
      }

      return { done: true };
    },
  };
}
