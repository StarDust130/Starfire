import { describe, expect, it } from "vitest";
import { buildDataset } from "../src/dataset/index.js";
import { MockOS } from "../src/mock/os.js";
import {
  checkToolArgs,
  runDeviceTool,
  STARFIRE_FUNCTION_SPECS,
  STARFIRE_TOOL_NAMES,
} from "../src/starfire.js";
import type { EvalCase } from "../src/types.js";

describe("dataset integrity", () => {
  const cases: EvalCase[] = buildDataset();

  it("has 220+ cases with unique ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(220);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("only expects tools that exist in the platform function specs", () => {
    const bad: string[] = [];
    for (const c of cases) {
      for (const callExp of c.expected.calls) {
        if (!(STARFIRE_TOOL_NAMES as readonly string[]).includes(callExp.tool))
          bad.push(c.id);
      }
    }
    expect(bad, `cases expecting unknown tools: ${bad.join(",")}`).toEqual([]);
  });

  it("expected arg keys match platform spec properties, enum values valid", () => {
    const problems: string[] = [];
    for (const c of cases) {
      for (const callExp of c.expected.calls) {
        const spec = STARFIRE_FUNCTION_SPECS.find(
          (s) => s.name === callExp.tool,
        );
        if (!spec || callExp.match === "any" || !callExp.args) continue;
        for (const [k, v] of Object.entries(callExp.args)) {
          const prop = spec.parameters.properties[k];
          if (!prop) {
            problems.push(
              `${c.id}: ${callExp.tool} has no arg "${k}" (spec: ${Object.keys(spec.parameters.properties).join(",")})`,
            );
            continue;
          }
          if (prop.enum && typeof v === "string" && !prop.enum.includes(v)) {
            problems.push(
              `${c.id}: ${callExp.tool}.${k}="${v}" not in enum [${prop.enum.join(",")}]`,
            );
          }
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("state paths reference known state keys", () => {
    const known = [
      "apps",
      "clipboard",
      "openUrls",
      "openFiles",
      "openFolders",
      "focusedApp",
      "sessionEnded",
      "weatherCalls",
      "searches",
    ];
    for (const c of cases) {
      for (const s of c.expected.state) {
        expect(
          known.some((k) => s.path.startsWith(k)),
          `${c.id}: bad state path ${s.path}`,
        ).toBe(true);
      }
    }
  });
});

describe("device dispatch behaves against mock ports", () => {
  it("open_app succeeds and flips mock state", async () => {
    const os = new MockOS();
    const res = await runDeviceTool(os, "open_app", { app: "Discord" }, 2000);
    expect(res.ok).toBe(true);
    expect(os.snapshot().apps.discord?.state).toBe("running");
  });

  it("missing required args fail gracefully", async () => {
    const os = new MockOS();
    const res = await runDeviceTool(os, "open_app", {}, 2000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("app");

    const check = checkToolArgs("open_app", {});
    expect(check.ok).toBe(false);
  });

  it("unknown tool returns graceful error", async () => {
    const os = new MockOS();
    const res = await runDeviceTool(os, "shell", {}, 2000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown device tool");
  });
});

describe("capability runtime validation", () => {
  it("rejects invalid system_info query values", async () => {
    const os = new MockOS();
    const res = await runDeviceTool(
      os,
      "system_info",
      { query: "banana" },
      2000,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Invalid "query"');
    expect(res.error).toContain("system_info");
  });

  it("still executes valid system_info queries", async () => {
    const os = new MockOS();
    const res = await runDeviceTool(
      os,
      "system_info",
      { query: "memory" },
      2000,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      summary: "Memory usage is at 62% (8.0 of 12.8 GB).",
      data: { usedPct: 62 },
    });
  });

  it("rejects invalid window_control actions", async () => {
    const os = new MockOS();
    const res = await runDeviceTool(
      os,
      "window_control",
      { action: "banana" },
      2000,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Invalid "action"');
  });

  it("still canonicalizes valid window_control synonyms", async () => {
    const os = new MockOS();
    await runDeviceTool(os, "open_app", { app: "Discord" }, 2000);

    await runDeviceTool(
      os,
      "window_control",
      { action: "minimize", app: "Discord" },
      2000,
    );
    expect(os.snapshot().apps.discord?.window).toBe("minimized");

    const res = await runDeviceTool(
      os,
      "window_control",
      { action: "unminimize", app: "Discord" },
      2000,
    );
    expect(res.ok).toBe(true);
    expect(os.snapshot().apps.discord?.window).toBe("normal");
  });
});
