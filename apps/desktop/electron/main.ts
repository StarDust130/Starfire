import { execFile } from "node:child_process";

import path from "node:path";

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  session,
} from "electron";

import { RealtimeVoiceBridge } from "./realtimeVoice";

const DEV_SERVER_URL =
  process.env.STARFIRE_DEV_SERVER_URL ?? "http://127.0.0.1:1420";

const GLOBAL_SHORTCUT = "Super+Z";

const DRAG_POLL_MS = 16;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

let voiceBridge: RealtimeVoiceBridge | null = null;

type DragSession = {
  offsetX: number;
  offsetY: number;
  timer: ReturnType<typeof setInterval>;
};

let dragSession: DragSession | null = null;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function stopDrag(): void {
  if (!dragSession) {
    return;
  }

  clearInterval(dragSession.timer);

  dragSession = null;
}

function startDrag(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (dragSession) {
    return;
  }

  const cursor = screen.getCursorScreenPoint();

  const position = mainWindow.getPosition();

  const windowX = position[0] ?? 0;
  const windowY = position[1] ?? 0;

  const session: DragSession = {
    offsetX: cursor.x - windowX,
    offsetY: cursor.y - windowY,

    timer: setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed() || !dragSession) {
        stopDrag();

        return;
      }

      const point = screen.getCursorScreenPoint();

      const nextX = point.x - dragSession.offsetX;
      const nextY = point.y - dragSession.offsetY;

      const current = mainWindow.getPosition();

      if (nextX !== current[0] || nextY !== current[1]) {
        mainWindow.setPosition(nextX, nextY, false);
      }
    }, DRAG_POLL_MS),
  };

  dragSession = session;
}

function hideFromTaskbar(): void {
  if (process.platform !== "linux" || !mainWindow) {
    return;
  }

  mainWindow.setSkipTaskbar(true);

  let attempts = 0;

  const apply = (): void => {
    attempts += 1;

    execFile("wmctrl", ["-lpx"], (error, stdout) => {
      if (error) {
        if (attempts < 10) {
          setTimeout(apply, 300);
        }

        return;
      }

      const line = stdout.split("\n").find((entry) => {
        const columns = entry.trim().split(/\s+/);

        return columns.length >= 3 && columns[2] === String(process.pid);
      });

      if (!line) {
        if (attempts < 10) {
          setTimeout(apply, 300);
        }

        return;
      }

      const windowId = line.trim().split(/\s+/)[0] ?? "";

      execFile("wmctrl", ["-i", "-r", windowId, "-b", "add,skip_taskbar"]);
    });
  };

  apply();
}

function registerGlobalShortcut(): void {
  globalShortcut.unregister(GLOBAL_SHORTCUT);

  const registered = globalShortcut.register(GLOBAL_SHORTCUT, () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    console.log("[main] ⌨️ Super+Z pressed.");

    mainWindow.webContents.send("starfire:global-listen");
  });

  if (!registered) {
    console.error(`[main] ❌ failed to register ${GLOBAL_SHORTCUT}`);

    return;
  }

  console.log(`[main] ✅ Global shortcut registered: ${GLOBAL_SHORTCUT}`);
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay();

  const workArea = display.workArea;

  const width = 280;
  const height = 350;

  const x = workArea.x + workArea.width - width - 24;
  const y = workArea.y + workArea.height - height - 24;

  mainWindow = new BrowserWindow({
    width,
    height,

    x,
    y,

    frame: false,

    transparent: true,

    hasShadow: false,

    roundedCorners: false,

    backgroundColor: "#00000000",

    focusable: true,

    skipTaskbar: true,

    alwaysOnTop: true,

    resizable: false,

    movable: true,

    show: false,

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),

      contextIsolation: true,

      nodeIntegration: false,

      sandbox: true,

      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating");

  mainWindow.setVisibleOnAllWorkspaces(true);

  mainWindow.webContents.on("input-event", (_event, input) => {
    if (dragSession && input.type === "mouseUp") {
      stopDrag();
    }
  });

  mainWindow.on("blur", () => {
    stopDrag();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;

    stopDrag();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow) {
      return;
    }

    mainWindow.show();

    hideFromTaskbar();

    console.log("[main] 🌟 Starfire window shown.");
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error(
        "[main] ❌ renderer load failed:",
        errorCode,
        errorDescription,
      );
    },
  );

  if (process.env.STARFIRE_DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  setTimeout(hideFromTaskbar, 1200);
}

ipcMain.on("starfire:drag-start", () => {
  startDrag();
});

ipcMain.on("starfire:drag-end", () => {
  stopDrag();
});

app.whenReady().then(() => {
  console.log(`[main] 🖥 platform: ${process.platform}`);

  console.log(
    `[main] 🪟 session: ${process.env.XDG_SESSION_TYPE ?? "unknown"}`,
  );

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media");
    },
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === "media",
  );

  createWindow();

  registerGlobalShortcut();

  voiceBridge = new RealtimeVoiceBridge(() => mainWindow);

  voiceBridge.register();
});

app.on("second-instance", () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
});

app.on("will-quit", () => {
  void voiceBridge?.dispose();

  voiceBridge = null;

  globalShortcut.unregisterAll();

  console.log("[main] 🛑 shortcuts released.");
});

app.on("window-all-closed", () => {
  app.quit();
});

function shutdown(): void {
  app.quit();
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);
