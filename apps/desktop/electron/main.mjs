// @ts-check

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, screen, session } from "electron";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const DEV_SERVER_URL =
  process.env.STARFIRE_DEV_SERVER_URL ?? "http://127.0.0.1:1420";

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;

/** @type {{
 * startX: number;
 * startY: number;
 * windowX: number;
 * windowY: number;
 * } | null}
 */
let dragState = null;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function hideFromTaskbar() {
  if (process.platform !== "linux" || !mainWindow) {
    return;
  }

  mainWindow.setSkipTaskbar(true);

  let attempts = 0;

  const apply = () => {
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

      const windowId = line.trim().split(/\s+/)[0];

      execFile("wmctrl", ["-i", "-r", windowId, "-b", "add,skip_taskbar"]);
    });
  };

  apply();
}

function createWindow() {
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
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating");

  mainWindow.setVisibleOnAllWorkspaces(true);

  mainWindow.on("closed", () => {
    mainWindow = null;
    dragState = null;
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow) {
      return;
    }

    mainWindow.show();
    hideFromTaskbar();

    console.log("[main] Starfire window shown.");
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error(
        "[main] renderer load failed:",
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

ipcMain.on("starfire:drag-start", (_event, payload) => {
  if (!mainWindow) {
    return;
  }

  if (
    typeof payload?.screenX !== "number" ||
    typeof payload?.screenY !== "number"
  ) {
    return;
  }

  const [windowX, windowY] = mainWindow.getPosition();

  dragState = {
    startX: payload.screenX,
    startY: payload.screenY,
    windowX,
    windowY,
  };
});

ipcMain.on("starfire:drag-move", (_event, payload) => {
  if (!mainWindow || !dragState) {
    return;
  }

  if (
    typeof payload?.screenX !== "number" ||
    typeof payload?.screenY !== "number"
  ) {
    return;
  }

  const x = dragState.windowX + payload.screenX - dragState.startX;

  const y = dragState.windowY + payload.screenY - dragState.startY;

  mainWindow.setPosition(Math.round(x), Math.round(y), false);
});

ipcMain.on("starfire:drag-end", () => {
  dragState = null;
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media");
    },
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      return permission === "media";
    },
  );

  createWindow();
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

app.on("window-all-closed", () => {
  app.quit();
});

const shutdown = () => {
  app.quit();
};

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);
