import type { ToolCall } from "../../packages/contracts/src/index.ts";

type Intent = {
  calls: ToolCall[];
};

const APP_WORDS =
  /\b(vs ?code|vscode|code|discord|firefox|chrome|brave|terminal|kitty|konsole|dolphin|calculator|spotify|vlc|mpv|telegram|steam|gimp|krita|obs|slack|thunderbird|notion|apple)\b/i;

const SITE_WORDS =
  /\b(youtube|github|google\.com|gmail|twitter|x\.com|reddit|amazon|netflix|instagram|facebook|pinterest|notion\.so)\b/i;

const LINK_PATTERN = /https?:\/\/\S+/i;

const GOODBYE =
  /\b(bye|goodbye|good ?bye|see ?you|that'?s all|talk (to you )?later|go now)\b|अलविदा|बाय/i;

const HINDI_SEARCH = /खबर|समाचार/;

function firstApp(utterances: string[]): string | null {
  for (const u of [...utterances].reverse()) {
    const match = u.match(APP_WORDS);

    if (match?.[0]) {
      return match[0];
    }
  }

  return null;
}

function firstSite(utterances: string[]): string | null {
  for (const u of [...utterances].reverse()) {
    const link = u.match(LINK_PATTERN);

    if (link?.[0]) {
      return link[0];
    }

    const match = u.match(SITE_WORDS);

    if (match?.[0]) {
      const site = match[0].toLowerCase();

      return `https://${site.includes(".") ? site : `${site}.com`}`;
    }
  }

  return null;
}

/**
 * Deterministic replay of the model's tool selection. Returns full
 * ToolCall objects (name + args together) — the runner feeds each
 * one into the REAL agent loop -> registry -> tool -> ports. Only
 * the decision itself is replayed; everything else is production
 * code. Failures here point at manifest gaps the real model would
 * also hit.
 */
export function decideTools(utterances: string[]): Intent {
  const all = utterances.join(" \n ").toLowerCase();

  const last = (utterances[utterances.length - 1] ?? "").toLowerCase();

  const calls: ToolCall[] = [];

  const push = (name: string, args: Record<string, unknown> = {}): void => {
    calls.push({ callId: `eval-${calls.length + 1}`, name, args });
  };

  // Pure-conversation traps first: no tool at all.
  const isPureConversation =
    /\bwhat is .*(plus|minus)\b/.test(all) ||
    /\btwo plus two\b/.test(all) ||
    /\btell me a joke\b/.test(all) ||
    /\bdo you like\b/.test(all) ||
    /\bhey\b/.test(last) ||
    /क्या हाल/.test(all) ||
    /time flies/.test(all) ||
    /open a conversation/.test(all);

  if (isPureConversation && !/weather/.test(all) && !/search/.test(all)) {
    return { calls };
  }

  // Goodbye.
  if (GOODBYE.test(all)) {
    push("end_session");

    return { calls };
  }

  // Weather.
  if (/\b(weather|jacket|rain)\b/.test(all)) {
    const placeMatch = all.match(/in ([a-z ]+?)(\?|$|,| today| now)/i);

    const place = placeMatch?.[1]?.trim();

    push("get_weather", place ? { place } : {});

    return { calls };
  }

  // Web search.
  if (
    /\b(search|latest news|news about|look up|current affair)\b/.test(all) ||
    HINDI_SEARCH.test(all)
  ) {
    const query = all.replace(/.*(search for|news about|search)\b/i, "").trim();

    push("web_search", { query: query.length > 0 ? query : "latest news" });

    return { calls };
  }

  // System info.
  if (/\b(ram|memory)\b/.test(all)) {
    push("system_info", { query: "memory" });

    return { calls };
  }

  if (/\b(up for|how long has|uptime|been on)\b/.test(all)) {
    push("system_info", { query: "uptime" });

    return { calls };
  }

  if (/\bbattery\b/.test(all)) {
    push("system_info", { query: "battery" });

    return { calls };
  }

  // Date/time.
  if (
    /\b(what time|the time|current time|what day|today'?s date|date today)\b/.test(
      all,
    )
  ) {
    push("current_date_time");

    return { calls };
  }

  // Window control.
  if (/\b(minimize|maximize|restore|lower)\b/.test(all)) {
    let action = "focus";

    if (/minimize/.test(all)) {
      action = "minimize";
    } else if (/maximize/.test(all)) {
      action = "maximize";
    } else if (/restore/.test(all)) {
      action = "restore";
    } else {
      action = "lower";
    }

    const app = firstApp(utterances) ?? "brave";

    push("window_control", { action, app });

    return { calls };
  }

  // Clipboard. NOTE: 'copy' must be here or "Copy 'x' for me" falls through.
  if (/\b(clipboard|what did i copy|copy)\b/.test(all)) {
    const writeMatch = last.match(/copy ['"](.+?)['"]/i);

    if (writeMatch?.[1]) {
      push("clipboard", { action: "write", text: writeMatch[1] });
    } else if (/copy something/.test(all)) {
      push("clipboard", { action: "write" });
    } else {
      push("clipboard", { action: "read" });
    }

    return { calls };
  }

  // Close app.
  if (/\b(close|quit)\b/.test(all)) {
    push("close_app", { app: firstApp(utterances) ?? "browser" });

    return { calls };
  }

  // Focus app.
  if (/\bfront\b/.test(all)) {
    push("focus_app", { app: firstApp(utterances) ?? "brave" });

    return { calls };
  }

  // Folders.
  if (/\bfolder\b/.test(all)) {
    push("open_folder", { path: "~/Projects" });

    return { calls };
  }

  // Files (extract the name the user said).
  const fileMatch = all.match(/open (?:the )?([a-z0-9._ -]+?)\s+file\b/i);

  if (fileMatch?.[1]) {
    push("open_file", { path: fileMatch[1].trim() });

    return { calls };
  }

  if (/\b(file|readme)\b/.test(all)) {
    push("open_file", { path: "README.md" });

    return { calls };
  }

  // Websites.
  const site = firstSite(utterances);

  if (site) {
    push("open_url", { url: site });

    return { calls };
  }

  // Apps.
  if (/\b(open|fire up|launch|kholo|start|run)\b/.test(all)) {
    const app = firstApp(utterances) ?? "unknown";

    push("open_app", { app });

    return { calls };
  }

  return { calls };
}
