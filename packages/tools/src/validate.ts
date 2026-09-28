import type { ToolParameterSchema } from "@starfire/contracts";

export type ValidatedArgs = Record<string, unknown>;

export type ValidationResult =
  | { ok: true; value: ValidatedArgs }
  | { ok: false; error: string };

/**
 * Validates raw model arguments against the SAME manifest the model
 * saw. Lenient about extra keys (models sometimes add junk), strict
 * about required keys, types, and enums.
 */
export function validateToolArgs(
  schema: ToolParameterSchema,
  args: unknown,
): ValidationResult {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }

  const input = args as Record<string, unknown>;

  const value: ValidatedArgs = {};

  for (const [key, property] of Object.entries(schema.properties)) {
    const raw = input[key];

    const present = raw !== undefined && raw !== null;

    if (!present) {
      if (schema.required.includes(key)) {
        return { ok: false, error: `missing required argument "${key}"` };
      }

      continue;
    }

    if (property.type === "string") {
      if (typeof raw !== "string") {
        return { ok: false, error: `argument "${key}" must be a string` };
      }

      if (raw.trim().length === 0) {
        return { ok: false, error: `argument "${key}" must not be empty` };
      }
    }

    if (property.type === "number") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, error: `argument "${key}" must be a number` };
      }
    }

    if (property.type === "boolean" && typeof raw !== "boolean") {
      return { ok: false, error: `argument "${key}" must be a boolean` };
    }

    if (property.enum && !property.enum.includes(raw as string)) {
      return {
        ok: false,
        error: `argument "${key}" must be one of: ${property.enum.join(", ")}`,
      };
    }

    value[key] = raw;
  }

  return { ok: true, value };
}
