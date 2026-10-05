import type { EvalCase } from "../types.js";
import { anyCall, call, S, state, U } from "./spec.js";

type Row = { u: string; lang?: "en" | "hi" | "hinglish" };

type MatrixSpec = {
  tool: string;
  args?: Record<string, unknown>;
  match?: "exact" | "normalized" | "contains" | "any";
  state?: {
    path: string;
    op: "to" | "equals";
    to?: unknown;
    value?: unknown;
  }[];
  forbidden?: string[];
  needsRunning?: string[];
  rows: Row[];
};

export const TOOL_MATRIX: MatrixSpec[] = [
  {
    tool: "open_app",
    args: { app: "Discord" },
    state: [{ path: "apps.discord.state", op: "to", to: "running" }],
    rows: [
      { u: "Open Discord" },
      { u: "hey can you open discord for me" },
      { u: "Discord" },
      {
        u: "I want to chat with my friends on Discord, can you get that on screen please",
      },
      { u: "open discrod" },
      { u: "डिस्कॉर्ड खोलो", lang: "hi" },
      { u: "discord khol do", lang: "hinglish" },
    ],
  },
  {
    tool: "open_app",
    args: { app: "VS Code" },
    state: [{ path: "apps.vs code.state", op: "to", to: "running" }],
    rows: [
      { u: "Open VS Code" },
      { u: "start vscode" },
      { u: "vs code" },
      { u: "I need to work on my project, open the code editor" },
      { u: "open v code" },
      { u: "वीएस कोड खोलो", lang: "hi" },
      { u: "vs code kholo", lang: "hinglish" },
    ],
  },
  {
    tool: "close_app",
    args: { app: "Spotify" },
    needsRunning: ["spotify"],
    state: [{ path: "apps.spotify.state", op: "to", to: "closed" }],
    rows: [
      { u: "Close Spotify" },
      { u: "quit spotify" },
      { u: "spotify band karo", lang: "hinglish" },
      { u: "स्पॉटिफ़ाई बंद करो", lang: "hi" },
      { u: "kill the spotify app please" },
    ],
  },
  {
    tool: "focus_app",
    args: { app: "Discord" },
    needsRunning: ["discord"],
    state: [{ path: "focusedApp", op: "to", to: "discord" }],
    rows: [
      { u: "Bring Discord to the front" },
      { u: "switch to discord" },
      { u: "discord pe lao", lang: "hinglish" },
      { u: "focus discord" },
    ],
  },
  {
    tool: "open_folder",
    args: { path: "~/Documents" },
    match: "contains",
    rows: [
      { u: "Open my Documents folder" },
      { u: "documents kholo", lang: "hinglish" },
      { u: "open the documents directory" },
    ],
  },
  {
    tool: "open_file",
    args: { path: "~/notes/todo.txt" },
    match: "contains",
    rows: [
      { u: "Open the file at ~/notes/todo.txt" },
      { u: "open todo.txt from my notes folder" },
      { u: "mera todo.txt kholo", lang: "hinglish" },
    ],
  },
  {
    tool: "open_url",
    args: { url: "youtube" },
    match: "contains",
    forbidden: ["open_app"],
    state: [{ path: "openUrls", op: "to", to: ["https://youtube.com"] }],
    rows: [
      { u: "Open YouTube" },
      { u: "open youtube.com" },
      { u: "youtube kholo", lang: "hinglish" },
      { u: "यूट्यूब खोलो", lang: "hi" },
      { u: "I want to watch videos, open YouTube" },
    ],
  },
  {
    tool: "clipboard",
    args: { action: "write" },
    match: "any",
    state: [{ path: "clipboard", op: "to", to: "hello world" }],
    rows: [
      { u: "Copy hello world" },
      { u: "copy the text hello world to clipboard" },
      { u: "hello world copy karo", lang: "hinglish" },
    ],
  },
  {
    tool: "system_info",
    args: { query: "memory" },
    rows: [
      { u: "How much RAM am I using?" },
      { u: "what's my memory usage?" },
      { u: "ram kitni use ho rahi hai", lang: "hinglish" },
      { u: "मेमोरी यूसेज कितना है?", lang: "hi" },
    ],
  },
  {
    tool: "system_info",
    args: { query: "cpu" },
    rows: [
      { u: "What's my CPU usage?" },
      { u: "cpu kitna use ho raha hai", lang: "hinglish" },
    ],
  },
  {
    tool: "web_search",
    args: { query: "React" },
    match: "contains",
    rows: [
      { u: "Search for the latest React release" },
      { u: "google the newest react version" },
      { u: "react ka latest version search karo", lang: "hinglish" },
    ],
  },
  {
    tool: "get_weather",
    args: { place: "Tokyo" },
    match: "contains",
    rows: [
      { u: "What's the weather in Tokyo?" },
      { u: "tokyo ka mausam", lang: "hinglish" },
      { u: "टोक्यो में मौसम कैसा है?", lang: "hi" },
      { u: "weather report for Tokyo please" },
    ],
  },
  {
    tool: "window_control",
    args: { action: "minimize", app: "Discord" },
    needsRunning: ["discord"],
    match: "contains",
    state: [{ path: "apps.discord.window", op: "to", to: "minimized" }],
    rows: [
      { u: "Minimize Discord" },
      { u: "discord ko minimize karo", lang: "hinglish" },
      { u: "shrink the discord window" },
    ],
  },
  {
    tool: "window_control",
    args: { action: "maximize", app: "Discord" },
    needsRunning: ["discord"],
    match: "contains",
    state: [{ path: "apps.discord.window", op: "to", to: "maximized" }],
    rows: [{ u: "Maximize Discord" }, { u: "make discord fullscreen" }],
  },
  {
    tool: "current_date_time",
    match: "any",
    rows: [
      { u: "What time is it?" },
      { u: "what's the date today?" },
      { u: "aaj ki date kya hai", lang: "hinglish" },
      { u: "अभी क्या बजा है?", lang: "hi" },
    ],
  },
];

export function expandToolMatrix(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const spec of TOOL_MATRIX) {
    const initialState: Record<string, unknown> | undefined = spec.needsRunning
      ? Object.fromEntries(
          spec.needsRunning.map((n) => [
            n,
            { state: "running", window: "normal", focused: false },
          ]),
        )
      : undefined;
    for (const row of spec.rows) {
      cases.push(
        S({
          id: "TBD",
          title: `${spec.tool}: "${row.u.slice(0, 44)}"`,
          category: "tool",
          tags: ["matrix", spec.tool, row.lang ?? "en"],
          turns: [U(row.u, row.lang)],
          calls: [call(spec.tool, spec.args, spec.match ?? "normalized")],
          forbidden: spec.forbidden,
          minCalls: 1,
          state: spec.state?.map((x) => state(x.path, x.to)) ?? [],
          initialState,
          severity: "P1",
        }),
      );
    }
  }
  return cases;
}

export function expandMultiTurn(): EvalCase[] {
  const apps = [
    { display: "Discord", key: "discord" },
    { display: "Spotify", key: "spotify" },
    { display: "VS Code", key: "vs code" },
    { display: "Chrome", key: "chrome" },
  ];
  const followups = [
    { u: "bring it to the front", tool: "focus_app" },
    { u: "minimize it", tool: "window_control" },
    { u: "close it", tool: "close_app" },
    { u: "maximize it", tool: "window_control" },
  ];
  const cases: EvalCase[] = [];
  for (const app of apps) {
    for (const f of followups) {
      const toState = f.tool === "close_app" ? "closed" : "running";
      cases.push(
        S({
          id: "TBD",
          title: `Open ${app.display} → "${f.u}"`,
          category: "multi-turn",
          tags: ["anaphora", f.tool],
          turns: [U(`Open ${app.display}`), U(f.u)],
          calls: [call("open_app", { app: app.display }), anyCall(f.tool)],
          minCalls: 2,
          maxCalls: 3,
          state: [state(`apps.${app.key}.state`, toState)],
          severity: "P1",
          important: true,
        }),
      );
    }
  }
  return cases;
}
