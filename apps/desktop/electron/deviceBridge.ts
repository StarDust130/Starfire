import { randomUUID } from "node:crypto";

import { createServer, type IncomingMessage } from "node:http";

import type { AgentPorts } from "@starfire/contracts";

import { executeDeviceTool } from "@starfire/contracts";

const DEFAULT_PORT = 17321;

const MAX_BODY_BYTES = 64 * 1024;

/*
 * Bodies are ALWAYS fully consumed before ANY response is sent (up to
 * this drain cap). This is what makes error responses deterministic:
 * if we responded while a client was still uploading, Node would
 * destroy the socket mid-upload and the client would see a transport
 * error instead of our clean 401/500. Beyond the drain cap (flagrant
 * abuse) we destroy the connection; a reset is acceptable there.
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

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; tooLarge: true; socketDead: boolean };

/**
 * Consumes the ENTIRE request body. Buffers up to MAX_BODY_BYTES;
 * anything larger is drained-and-discarded (bounded) and flagged.
 * Never throws for oversize — callers decide.
 */
async function readBody(request: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];

  let total = 0;

  let tooLarge = false;

  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);

      total += buffer.length;

      if (total > MAX_DRAIN_BYTES) {
        // Flagrant abuse: stop reading; a reset is acceptable here.
        request.destroy();

        return { ok: false, tooLarge: true, socketDead: true };
      }

      if (total > MAX_BODY_BYTES) {
        tooLarge = true; // keep draining so the client finishes cleanly

        continue;
      }

      chunks.push(buffer);
    }
  } catch {
    // Stream aborted/destroyed mid-read — nothing sane to respond to.
    return { ok: false, tooLarge: true, socketDead: true };
  }

  if (tooLarge) {
    return { ok: false, tooLarge: true, socketDead: false };
  }

  return {
    ok: true,
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  // Never write to a socket the request already destroyed.
  if (response.socket?.destroyed) {
    return;
  }

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
      /*
       * Consume the body BEFORE any response — this ordering is the
       * guarantee that clients always finish uploading before we
       * answer, for every status code below.
       */
      const body = await readBody(request);

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
        sendJson(response, 401, {
          ok: false,
          error: "Unauthorized device request.",
        });

        return;
      }

      if (!body.ok) {
        if (body.socketDead) {
          // The connection is already gone; there is nobody to answer.
          return;
        }

        // Bounded drain completed — answer cleanly and close the
        // connection so the client's pooled socket is not reused.
        response.setHeader("connection", "close");

        sendJson(response, 500, {
          ok: false,
          error: "Request body is too large.",
        });

        return;
      }

      let parsed: unknown;

      try {
        parsed = body.text.length > 0 ? JSON.parse(body.text) : {};
      } catch {
        throw new Error("Request body must be valid JSON.");
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("Request body must be an object.");
      }

      const record = parsed as Record<string, unknown>;

      const tool = record.tool;

      const args =
        record.args &&
        typeof record.args === "object" &&
        !Array.isArray(record.args)
          ? (record.args as Record<string, unknown>)
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
      /*
       * Kill keep-alive sockets deterministically before closing so
       * no client ever races a closing server across restarts.
       */
      server.closeIdleConnections();

      server.close(() => resolve());
    });
}
