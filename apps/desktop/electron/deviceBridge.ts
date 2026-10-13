import { randomUUID } from "node:crypto";

import { createServer, type IncomingMessage } from "node:http";

import type { AgentPorts } from "@starfire/contracts";

import { executeDeviceTool } from "@starfire/contracts";

const DEFAULT_PORT = 17321;

const MAX_BODY_BYTES = 64 * 1024;

/*
 * Over-limit bodies are DRAINED up to this cap so the client can
 * finish uploading and actually receive our error response — without
 * draining, Node destroys the socket mid-upload and the client sees a
 * transport error instead of our clean 500. Beyond the drain cap
 * (flagrant abuse) we abort; a connection reset is acceptable there.
 */
const MAX_DRAIN_BYTES = MAX_BODY_BYTES * 8;

/*
 * Local HTTP bridge between Eve agents and Starfire's trusted
 * capability layer. Loopback-only by binding.
 *
 * AUTHENTICATION: a per-launch token is ALWAYS in effect. Resolution
 * order: explicit option (tests) → STARFIRE_DEVICE_TOKEN env → a
 * securely generated random token for this launch. The generated
 * token is written back to process.env so the in-process Eve runtime
 * inherits it through trusted local configuration — it is never
 * logged, never rendered, never committed.
 */

export type DeviceBridgeHandlers = {
  searchMemory?: (query: string) => string;
};

export type DeviceBridgeOptions = {
  /** Overrides env for tests. */
  token?: string;
};

/** Reads & discards the request body, bounded. Never parses. */
async function drainBody(request: IncomingMessage): Promise<void> {
  let drained = 0;

  for await (const chunk of request) {
    drained += Buffer.from(chunk).length;

    if (drained > MAX_DRAIN_BYTES) {
      // Flagrant abuse: stop reading; a reset is acceptable here.
      request.destroy();

      return;
    }
  }
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  /*
   * Deterministic rejection for bodies that declare their size up
   * front: drain first (so the client finishes cleanly), then fail.
   */
  const declared = request.headers["content-length"];

  const declaredBytes =
    typeof declared === "string" ? Number(declared) : Number.NaN;

  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
    await drainBody(request);

    throw new Error("Request body is too large.");
  }

  const chunks: Buffer[] = [];

  let total = 0;

  let tooLarge = false;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);

    total += buffer.length;

    if (total > MAX_DRAIN_BYTES) {
      // Flagrant abuse (chunked/undeclared): stop reading.
      throw new Error("Request body is too large.");
    }

    if (total > MAX_BODY_BYTES) {
      tooLarge = true; // keep draining so the client finishes cleanly

      continue;
    }

    chunks.push(buffer);
  }

  if (tooLarge) {
    throw new Error("Request body is too large.");
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
  handlers: DeviceBridgeHandlers = {},
  options: DeviceBridgeOptions = {},
): Promise<() => Promise<void>> {
  const explicit = options.token ?? process.env.STARFIRE_DEVICE_TOKEN?.trim();

  const token = explicit && explicit.length > 0 ? explicit : randomUUID();

  // Make the effective token visible to the in-process Eve runtime
  // through trusted local configuration (never logged).
  if (process.env.STARFIRE_DEVICE_TOKEN !== token) {
    process.env.STARFIRE_DEVICE_TOKEN = token;
  }

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

      const provided = request.headers["x-starfire-device-token"];

      if (provided !== token) {
        // Auth rejected: the body is never trusted — no drain needed.
        sendJson(response, 401, {
          ok: false,
          error: "Unauthorized device request.",
        });

        return;
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

      /*
       * memory_search is served from the local memory database in this
       * trusted process — Eve agents reach it over this boundary.
       */
      if (tool === "memory_search") {
        const search = handlers.searchMemory;

        if (!search) {
          sendJson(response, 200, {
            ok: false,
            result: null,
            error: "Memory is not available.",
          });

          return;
        }

        const query =
          typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";

        if (query.length === 0) {
          sendJson(response, 200, {
            ok: false,
            result: null,
            error: "Missing query.",
          });

          return;
        }

        sendJson(response, 200, {
          ok: true,
          result: search(query),
        });

        return;
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

  console.log(
    `[Starfire Device] listening on http://127.0.0.1:${port} ` +
      `(auth: ${explicit ? "configured token" : "per-launch token"})`,
  );

  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
}
