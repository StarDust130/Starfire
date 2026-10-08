import { createServer, type IncomingMessage } from "node:http";

import type { AgentPorts } from "@starfire/contracts";

const DEFAULT_PORT = 17321;

const DEVICE_TOKEN = process.env.STARFIRE_DEVICE_TOKEN;

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);

    total += buffer.length;

    if (total > 64 * 1024) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");

  const value: unknown = JSON.parse(text);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be an object.");
  }

  return value as Record<string, unknown>;
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing "${name}".`);
  }

  return value;
}

function optionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];

  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * The single Starfire platform dispatch: one capability name + args in,
 * a plain result (or thrown error) out.
 *
 * Every path goes through here:
 *   Eve agent  → Eve tool  → HTTP /v1/tool  → this dispatch
 *   voice      → function call                  → this dispatch
 *
 * It knows nothing about Linux, KWin, or Electron internals —
 * those live behind the ports.
 */
export async function executeDeviceTool(
  ports: AgentPorts,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (tool) {
    case "open_app":
      return ports.apps.open(requireString(args, "app"));

    case "close_app":
      return ports.apps.close(requireString(args, "app"));

    case "focus_app":
      return ports.apps.focus(requireString(args, "app"));

    case "open_file":
      return ports.files.openFile(requireString(args, "path"));

    case "open_folder":
      return ports.files.openFolder(requireString(args, "path"));

    case "open_url":
      return ports.urls.open(requireString(args, "url"));

    case "clipboard_read":
      return { text: await ports.clipboard.read() };

    case "clipboard_write": {
      await ports.clipboard.write(requireString(args, "text"));

      return undefined;
    }

    case "system_info":
      return ports.system.info(requireString(args, "query") as never);

    case "web_search":
      return ports.web.search(requireString(args, "query"));

    case "get_weather":
      return ports.weather.current(optionalString(args, "place"));

    case "window_control":
      return ports.windows.control(
        requireString(args, "action") as never,
        optionalString(args, "app"),
      );

    default:
      throw new Error(`Unknown device tool "${tool}".`);
  }
}

export async function startDeviceBridge(
  ports: AgentPorts,
  port = DEFAULT_PORT,
): Promise<() => Promise<void>> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") {
        sendJson(response, 405, {
          ok: false,
          error: "Only POST is allowed.",
        });

        return;
      }

      if (request.url !== "/v1/tool") {
        sendJson(response, 404, {
          ok: false,
          error: "Not found.",
        });

        return;
      }

      if (DEVICE_TOKEN) {
        const token = request.headers["x-starfire-device-token"];

        if (token !== DEVICE_TOKEN) {
          sendJson(response, 401, {
            ok: false,
            error: "Unauthorized device request.",
          });

          return;
        }
      }

      const body = await readJson(request);

      const tool = body.tool;

      const args =
        body.args && typeof body.args === "object" && !Array.isArray(body.args)
          ? (body.args as Record<string, unknown>)
          : {};

      if (typeof tool !== "string") {
        throw new Error("Missing tool name.");
      }

      const result = await executeDeviceTool(ports, tool, args);

      sendJson(response, 200, {
        ok: true,
        result: result ?? null,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Device operation failed.";

      sendJson(response, 500, {
        ok: false,
        error: message,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);

    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  console.log(`[Starfire Device] listening on http://127.0.0.1:${port}`);

  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
}
