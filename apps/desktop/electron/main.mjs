import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, screen, session } from "electron";

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const DEV_SERVER_URL =
  process.env.STARFIRE_DEV_SERVER_URL ?? "http://127.0.0.1:1420";

const isDev = Boolean(process.env.STARFIRE_DEV_SERVER_URL);

let mainWindow = null;
let dragState = null;

function createWindow() {
  const width = 280;
  const height = 350;

  mainWindow = new BrowserWindow({
    width,
    height,

    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: "#00000000",

    type: "toolbar",

    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,

    show: true,

    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // 🚫 Never appear in KDE taskbar/window list.
  mainWindow.setSkipTaskbar(true);

  mainWindow.setAlwaysOnTop(true, "floating");

  mainWindow.setVisibleOnAllWorkspaces(true);

  // KDE/XWayland can re-evaluate the taskbar
  // state when the window becomes visible.
  mainWindow.once("show", () => {
    mainWindow?.setSkipTaskbar(true);
  });

  const { workArea } = screen.getPrimaryDisplay();

  const x = workArea.x + workArea.width - width - 24;

  const y = workArea.y + workArea.height - height - 18;

  mainWindow.setPosition(x, y);

  mainWindow.setSkipTaskbar(true);

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("🌟 Starfire renderer loaded.");
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error("❌ Renderer failed:", errorCode, errorDescription);
    },
  );

  mainWindow.on("closed", () => {
    mainWindow = null;
    dragState = null;
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.on("second-instance", () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.showInactive();
});

// ─────────────────────────────────────
// 🖱️ Dragging
// ─────────────────────────────────────

ipcMain.on("starfire:drag-start", (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window) {
    return;
  }

  if (
    typeof payload?.screenX !== "number" ||
    typeof payload?.screenY !== "number"
  ) {
    return;
  }

  const [windowX, windowY] = window.getPosition();

  dragState = {
    webContentsId: event.sender.id,
    startMouseX: payload.screenX,
    startMouseY: payload.screenY,
    startWindowX: windowX,
    startWindowY: windowY,
  };
});

ipcMain.on("starfire:drag-move", (event, payload) => {
  if (!dragState) {
    return;
  }

  if (dragState.webContentsId !== event.sender.id) {
    return;
  }

  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window) {
    return;
  }

  if (
    typeof payload?.screenX !== "number" ||
    typeof payload?.screenY !== "number"
  ) {
    return;
  }

  const deltaX = payload.screenX - dragState.startMouseX;

  const deltaY = payload.screenY - dragState.startMouseY;

  window.setPosition(
    Math.round(dragState.startWindowX + deltaX),
    Math.round(dragState.startWindowY + deltaY),
  );
});

ipcMain.on("starfire:drag-end", (event) => {
  if (dragState?.webContentsId === event.sender.id) {
    dragState = null;
  }
});

// ─────────────────────────────────────
// 🚀 Electron lifecycle
// ─────────────────────────────────────

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

// IMPORTANT:
// Make Ctrl+C / SIGTERM from the
// dev runner actually close Electron.
process.on("SIGTERM", () => {
  app.quit();
});

process.on("SIGINT", () => {
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
