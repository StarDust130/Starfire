import { createServer, type IncomingMessage } from "node:http";
import type { AgentPorts } from "@starfire/contracts";
import { executeDeviceTool } from "@starfire/contracts";

const DEFAULT_PORT = 17321;

const DEVICE_TOKEN = process.env.STARFIRE_DEVICE_TOKEN;

/*
 * executeDeviceTool is Starfire's shared capability dispatch, re-exported
 * here for the Eve HTTP boundary (and imported by the realtime voice
 * bridge). The dispatch lives in @starfire/contracts so voice and Eve
 * share one execution layer; this file only serves it over HTTP.
 */
export { executeDeviceTool };

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
