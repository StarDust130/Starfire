type DeviceResponse<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      error: string;
    };

const DEVICE_URL = process.env.STARFIRE_DEVICE_URL ?? "http://127.0.0.1:17321";

const DEVICE_TOKEN = process.env.STARFIRE_DEVICE_TOKEN;

async function callDevice<T>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${DEVICE_URL}/v1/tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",

        ...(DEVICE_TOKEN
          ? {
              "x-starfire-device-token": DEVICE_TOKEN,
            }
          : {}),
      },
      body: JSON.stringify({
        tool,
        args,
      }),
      signal: controller.signal,
    });

    const body = (await response.json()) as DeviceResponse<T>;

    if (!response.ok || !body.ok) {
      throw new Error(
        body.ok
          ? `Device request failed with HTTP ${response.status}.`
          : body.error,
      );
    }

    return body.result;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Starfire device: ${error.message}`);
    }

    throw new Error("Starfire device request failed.");
  } finally {
    clearTimeout(timer);
  }
}

export const desktop = {
  apps: {
    open(app: string) {
      return callDevice<{
        name: string;
        pid?: number;
      }>("open_app", { app });
    },

    close(app: string) {
      return callDevice<{
        closed: boolean;
        via: "pid" | "name" | "not-found";
        detail?: string;
      }>("close_app", { app });
    },

    focus(app: string) {
      return callDevice<{
        focused: boolean;
        detail?: string;
      }>("focus_app", { app });
    },
  },

  files: {
    openFile(path: string) {
      return callDevice<{
        opened: string;
      }>("open_file", { path });
    },

    openFolder(path: string) {
      return callDevice<{
        opened: string;
      }>("open_folder", { path });
    },
  },

  urls: {
    open(url: string) {
      return callDevice<{
        opened: string;
      }>("open_url", { url });
    },
  },

  clipboard: {
    read() {
      return callDevice<{
        text: string;
      }>("clipboard_read");
    },

    write(text: string) {
      return callDevice<void>("clipboard_write", { text });
    },
  },

  system: {
    info(query: string) {
      return callDevice<{
        summary: string;
        data?: Record<string, unknown>;
      }>("system_info", { query });
    },
  },

  web: {
    search(query: string) {
      return callDevice<{
        answer: string;
        results: Array<{
          title: string;
          url: string;
          snippet: string;
        }>;
      }>("web_search", { query });
    },
  },

  weather: {
    current(place?: string) {
      return callDevice<{
        summary: string;
        temperatureC: number | null;
        data?: Record<string, unknown>;
      }>("get_weather", { place });
    },
  },

  windows: {
    control(action: string, app?: string) {
      return callDevice<{
        done: boolean;
        detail?: string;
      }>("window_control", {
        action,
        app,
      });
    },
  },
};
