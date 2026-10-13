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

import { createElectronPorts } from "./agent/electron-ports.js";

import { startDeviceBridge } from "./deviceBridge.js";

import { startEveRuntime, stopEveRuntime } from "./eve-runtime.js";

import type { VoiceTranscriptRecorder } from "./memory/capture.js";

import type { MemoryDatabase } from "./memory/database.js";

import type { MemoryOrchestrator } from "./memory/orchestrator.js";

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

let stopDeviceBridge: (() => Promise<void>) | null = null;

let memoryDatabase: MemoryDatabase | null = null;

let memoryOrchestrator: MemoryOrchestrator | null = null;

let transcriptRecorder: VoiceTranscriptRecorder | null = null;

let getCoreMemory: (() => string) | null = null;

let searchMemory: ((query: string) => string) | null = null;

let eveSearchMemory: ((query: string) => string) | null = null;

let liveVoiceSessionId: string | null = null;

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

app.whenReady().then(async () => {
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

  /*

* Memory V1.1 + Context V1.2 — one trusted SQLite store owned by

* this process. Dynamic import on purpose: a missing or broken

* database backend only disables memory; Starfire itself starts.

*/

  try {
    const memory = await import("./memory/index.js");

    memoryDatabase = await memory.openMemoryDatabase({
      userDataDir: app.getPath("userData"),
    });

    if (memoryDatabase) {
      const provider = new memory.GlmExtractionProvider(
        memory.resolveExtractionConfig(),
      );

      memoryOrchestrator = new memory.MemoryOrchestrator({
        db: memoryDatabase,

        messages: new memory.MessageStore(memoryDatabase),

        jobs: new memory.MemoryJobs(memoryDatabase),

        memories: new memory.MemoryStore(memoryDatabase),

        provider,
      });

      memoryOrchestrator.recover();

      const coreMemoryProvider = new memory.CoreMemoryProvider(
        new memory.MemoryStore(memoryDatabase),
      );

      getCoreMemory = (): string => coreMemoryProvider.get();

      /*
       * Snapshot of the Core Memory rows actually SENT to the voice
       * model. Refreshed when a session starts (the same moment the
       * bridge sends/refreshes the block) — NOT recomputed per search,
       * so a memory saved mid-session stays searchable until it has
       * really been delivered to the model.
       */
      let sentCoreMemoryIds = new Set<number>();

      const syncCoreSnapshot = (): void => {
        sentCoreMemoryIds = new Set(
          coreMemoryProvider.select().injected.map((entry) => entry.id),
        );
      };

      syncCoreSnapshot();

      const contextBuilder = new memory.ContextBuilder(
        new memory.MemorySearch(memoryDatabase),
      );

      /*
       * Voice retrieval: excludes EXACTLY the rows the model already
       * received (sent snapshot, budget-aware) plus the live session.
       * Eve retrieval: no exclusions — Eve never received Core Memory.
       */
      searchMemory = (query: string): string =>
        contextBuilder.build(query, {
          excludeCoreMemoryIds: sentCoreMemoryIds,
          excludeSessionIds:
            liveVoiceSessionId === null
              ? undefined
              : new Set([liveVoiceSessionId]),
        });

      eveSearchMemory = (query: string): string => contextBuilder.build(query);

      const explicitStore = new memory.MemoryStore(memoryDatabase);

      transcriptRecorder = new memory.VoiceTranscriptRecorder(
        new memory.MessageStore(memoryDatabase),

        {
          onSessionStarted: (sessionId: string) => {
            liveVoiceSessionId = sessionId;

            // The bridge sends/refreshes Core Memory at activation —
            // keep the sent-snapshot in lockstep.
            syncCoreSnapshot();
          },

          onTurnCaptured: (turn) => {
            memoryOrchestrator?.notifyTurn();

            /*

* Explicit-statement fast path: stored IMMEDIATELY and

* locally so a fact survives even if the app closes

* seconds later. GLM still refines the wording later —

* the stable key means confirm/supersede handles it.

*/

            if (turn.role !== "user") {
              return;
            }

            const fact = memory.detectExplicitFact(turn.content);

            if (!fact) {
              return;
            }

            const safety = memory.redactSecrets(turn.content);

            if (safety.redactions.length > 0) {
              console.warn(
                "[Memory] 🔒 explicit fact contained a secret-shaped value — not stored",
              );

              return;
            }

            const result = explicitStore.recordFact({
              category: fact.category,

              key: fact.key,

              content: fact.content,

              importance: fact.importance,

              sourceMessageIds: [turn.id],
            });

            if (result.ok) {
              console.log(
                `[Memory] ⚡ ${result.action}: ${fact.category}/${fact.key} (chars=${fact.content.length})`,
              );
            }
          },

          onSessionEnded: () => {
            /*
             * After a session ends its turns become searchable past
             * chats for EVERYONE (including Eve). Extraction is NOT
             * triggered here — short sessions are parts of one ongoing
             * history; the idle/batch triggers handle extraction.
             */
            liveVoiceSessionId = null;
          },
        },
      );

      console.log(
        `[Memory] ✅ ready v${memoryDatabase.schemaVersion} → ${memoryDatabase.path}`,
      );
    } else {
      console.log("[Memory] ⏸ disabled by configuration");
    }
  } catch (error) {
    memoryDatabase = null;

    console.error(
      "[Memory] ❌ unavailable:",

      error instanceof Error ? error.message : error,
    );
  }

  /*

* One ports instance is Starfire's local capability layer, shared

* by the Eve device bridge and the realtime voice bridge so both

* paths see the same state (e.g. apps Starfire launched herself).

*/

  const ports = createElectronPorts();

  voiceBridge = new RealtimeVoiceBridge(
    () => mainWindow,

    ports,

    transcriptRecorder ?? undefined,

    getCoreMemory ?? undefined,

    searchMemory ?? undefined,
  );

  voiceBridge.register();

  // Warm the provider connection while idle; no microphone audio is sent.

  void voiceBridge.warmUp();

  /*

* The device bridge MUST be listening before the Eve runtime starts:

* Eve tools call it over HTTP, and an early tool call would otherwise

* hit a closed port.

*/

  startDeviceBridge(ports, undefined, {
    searchMemory: eveSearchMemory ?? undefined,
  })

    .then((stop) => {
      stopDeviceBridge = stop;

      console.log("[Starfire Device] event=bridge-started");

      return startEveRuntime();
    })

    .catch((error) => {
      console.error(
        "[Starfire Device] event=bridge-start-failed:",

        error instanceof Error ? error.message : error,
      );

      console.error(
        "[Starfire Device] Eve tools will not be able to reach the device bridge.",
      );
    });
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

app.on("will-quit", (event) => {
  /*

* Hold the quit until everything (voice, device bridge, the

* in-process Eve runtime, memory) has torn down.

*/

  event.preventDefault();

  const finish = (): void => {
    globalShortcut.unregisterAll();

    console.log("[main] 🛑 shortcuts released.");

    app.exit(0);
  };

  const teardown = async (): Promise<void> => {
    const teardownStartedAt = Date.now();

    await voiceBridge?.dispose();

    voiceBridge = null;

    await stopDeviceBridge?.();

    stopDeviceBridge = null;

    console.log("[Starfire Device] event=bridge-stopped");

    await stopEveRuntime();

    if (memoryOrchestrator) {
      await memoryOrchestrator.shutdown();

      memoryOrchestrator = null;
    }

    if (memoryDatabase) {
      memoryDatabase.close();

      memoryDatabase = null;

      console.log("[Memory] event=database-closed");
    }

    console.log(
      `[Starfire Device] event=shutdown-complete durationMs=${Date.now() - teardownStartedAt}`,
    );
  };

  teardown().then(finish).catch(finish);
});

app.on("window-all-closed", () => {
  app.quit();
});

function shutdown(): void {
  app.quit();
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);
