import type { CaseInput } from "./types.ts";

/**
 * 47 production-eval scenarios: normal, ambiguous, invalid, failure,
 * edge, multi-turn, wrong-tool traps, and voice-specific cases.
 */
export const CASES: Array<CaseInput & { id: string; title: string }> = [
  {
    id: "C01",
    title: "open_app: normal request",
    category: "tool",
    utterances: ["Open VS Code"],

    expect: { tools: ["open_app"], summaryContains: ["opening"] },

    latencyBudgetMs: 800,
  },
  {
    id: "C02",
    title: "open_app: casual phrasing",
    category: "tool",
    utterances: ["yo fire up discord for me"],

    expect: { tools: ["open_app"], summaryContains: ["opening"] },
  },
  {
    id: "C03",
    title: "open_app: app not installed",
    category: "failure",
    utterances: ["Open Apple"],

    expect: { tools: ["open_app"], summaryContains: ["couldn't find"] },
  },
  {
    id: "C04",
    title: "open_app: empty-ish name (invalid)",
    category: "invalid",
    utterances: ["Open"],

    expect: { tools: ["open_app"] },
  },
  {
    id: "C05",
    title: "open_app: hindi phrasing",
    category: "tool",
    utterances: ["vs code kholo"],

    expect: { tools: ["open_app"] },
  },
  {
    id: "C06",
    title: "close_app: app not running",
    category: "failure",
    utterances: ["Close Spotify"],

    expect: { tools: ["close_app"], summaryContains: ["couldn't find"] },
  },
  {
    id: "C07",
    title: "multi-turn: open then close the same app",
    category: "multi-turn",
    utterances: ["Open Discord", "Close Discord"],

    expect: { tools: ["open_app", "close_app"], summaryContains: ["closing"] },
  },
  {
    id: "C08",
    title: "focus_app: bring to front",
    category: "tool",
    utterances: ["Bring Firefox to the front"],

    expect: { tools: ["focus_app"], summaryContains: ["front"] },
  },
  {
    id: "C09",
    title: "open_url: website by name",
    category: "tool",
    utterances: ["Open YouTube"],

    expect: { tools: ["open_url"], summaryContains: ["opening"] },
  },
  {
    id: "C10",
    title: "open_url: full https link",
    category: "tool",
    utterances: ["Open https://github.com/starfire"],

    expect: { tools: ["open_url"] },
  },
  {
    id: "C11",
    title: "open_url: invalid url",
    category: "invalid",
    utterances: ["Open ftp://bad"],

    expect: {
      tools: ["open_url", "open_app"],
      summaryNotContains: ["undefined"],
    },
  },
  {
    id: "C12",
    title: "open_folder: normal",
    category: "tool",
    utterances: ["Open my Projects folder"],

    expect: { tools: ["open_folder"] },
  },
  {
    id: "C13",
    title: "open_file: normal",
    category: "tool",
    utterances: ["Open README.md"],

    expect: { tools: ["open_file"] },
  },
  {
    id: "C14",
    title: "open_file: missing file (failure)",
    category: "failure",
    utterances: ["Open the missing-report file"],

    expect: { tools: ["open_file"], summaryContains: ["couldn't find"] },
  },
  {
    id: "C15",
    title: "clipboard: read",
    category: "tool",
    utterances: ["What did I copy?"],

    expect: { tools: ["clipboard"], summaryContains: ["clipboard"] },
  },
  {
    id: "C16",
    title: "clipboard: write",
    category: "tool",
    utterances: ["Copy 'hello starfire' for me"],

    expect: { tools: ["clipboard"], summaryContains: ["copied"] },
  },
  {
    id: "C17",
    title: "clipboard: write without text (invalid)",
    category: "invalid",
    utterances: ["Copy something to my clipboard"],

    expect: { tools: ["clipboard"], summaryContains: ["what should i copy"] },
  },
  {
    id: "C18",
    title: "system_info: RAM",
    category: "tool",
    utterances: ["How much RAM am I using?"],

    expect: { tools: ["system_info"], summaryContains: ["ram"] },
  },
  {
    id: "C19",
    title: "system_info: uptime",
    category: "tool",
    utterances: ["How long has my PC been on?"],

    expect: { tools: ["system_info"], summaryContains: ["up for"] },
  },
  {
    id: "C20",
    title: "system_info: battery",
    category: "tool",
    utterances: ["What's my battery level?"],

    expect: { tools: ["system_info"], summaryContains: ["battery"] },
  },
  {
    id: "C21",
    title: "web_search: current events",
    category: "tool",
    utterances: ["What's the latest news about SpaceX?"],

    expect: { tools: ["web_search"], summaryContains: ["found"] },
  },
  {
    id: "C22",
    title: "web_search: hindi query",
    category: "tool",
    utterances: ["भारत की आज की खबर बताओ"],

    expect: { tools: ["web_search"] },
  },
  {
    id: "C23",
    title: "web_search: empty results (edge)",
    category: "edge",
    utterances: ["Search for xyzzynothingexists"],

    expect: { tools: ["web_search"] },
  },
  {
    id: "C24",
    title: "weather: with place",
    category: "tool",
    utterances: ["What's the weather in Tokyo?"],

    expect: { tools: ["get_weather"], summaryContains: ["tokyo"] },
  },
  {
    id: "C25",
    title: "weather: no place (auto-location)",
    category: "tool",
    utterances: ["Will I need a jacket today?"],

    expect: { tools: ["get_weather"], summaryContains: ["°c"] },
  },
  {
    id: "C26",
    title: "date/time: what time is it",
    category: "tool",
    utterances: ["What time is it right now?"],

    expect: { tools: ["current_date_time"], summaryContains: ["it's"] },
  },
  {
    id: "C27",
    title: "date/time: what day is today",
    category: "tool",
    utterances: ["What day is today?"],

    expect: { tools: ["current_date_time"], summaryContains: ["day"] },
  },
  {
    id: "C28",
    title: "window_control: minimize",
    category: "tool",
    utterances: ["Minimize Brave"],

    expect: { tools: ["window_control"], summaryContains: ["minimized"] },
  },
  {
    id: "C29",
    title: "window_control: synonym 'bring to front'",
    category: "edge",
    utterances: ["Bring Brave to the front"],

    expect: {
      tools: ["focus_app", "window_control"],
      summaryContains: ["front"],
    },
  },
  {
    id: "C30",
    title: "window_control: invalid action",
    category: "invalid",
    utterances: ["Explode the brave window"],

    expect: { summaryNotContains: ["undefined"] },
  },
  {
    id: "C31",
    title: "conversation: greeting (no tool)",
    category: "conversation",
    utterances: ["Hey Starfire!"],

    expect: {
      notTools: [
        "open_app",
        "close_app",
        "open_url",
        "web_search",
        "clipboard",
        "system_info",
      ],
    },
  },
  {
    id: "C32",
    title: "conversation: personal question (no tool)",
    category: "conversation",
    utterances: ["Do you like music?"],

    expect: { notTools: ["web_search", "open_app", "open_url"] },
  },
  {
    id: "C33",
    title: "conversation: joke (no tool)",
    category: "conversation",
    utterances: ["Tell me a joke"],

    expect: { notTools: ["web_search"] },
  },
  {
    id: "C34",
    title: "conversation: math (no tool)",
    category: "conversation",
    utterances: ["What is five plus seven?"],

    expect: { notTools: ["web_search", "open_app", "open_url", "clipboard"] },
  },
  {
    id: "C35",
    title: "conversation: hindi small talk (no tool)",
    category: "conversation",
    utterances: ["क्या हाल है तुम्हारा?"],

    expect: { notTools: ["web_search", "open_app", "open_url"] },
  },
  {
    id: "C36",
    title: "trap: 'open a conversation' must not open anything",
    category: "invalid",
    utterances: ["Let's open a conversation about music"],

    expect: { notTools: ["open_app", "open_url", "open_folder"] },
  },
  {
    id: "C37",
    title: "trap: 'time flies' must not call date tool",
    category: "edge",
    utterances: ["Wow time flies when we talk"],

    expect: { notTools: ["current_date_time"] },
  },
  {
    id: "C38",
    title: "trap: 'weather report in the news' ambiguous",
    category: "edge",
    utterances: ["Did you see the weather report in the news?"],

    expect: { tools: ["get_weather", "web_search"] },
  },
  {
    id: "C39",
    title: "unnecessary tool: no search for 'what is 2+2'",
    category: "invalid",
    utterances: ["What is two plus two?"],

    expect: { notTools: ["web_search"] },
  },
  {
    id: "C40",
    title: "multi-turn: weather follow-up",
    category: "multi-turn",
    utterances: ["What's the weather in Tokyo?", "What about tomorrow?"],

    expect: { tools: ["get_weather"] },
  },
  {
    id: "C41",
    title: "multi-turn: search then summarize",
    category: "multi-turn",
    utterances: [
      "Search for the latest Arduino release",
      "Summarize the first one",
    ],

    expect: { tools: ["web_search"] },
  },
  {
    id: "C42",
    title: "voice: fast speech (loud, quick turn)",
    category: "voice",
    utterances: ["Open Spotify"],

    expect: { tools: ["open_app"], micRms: 0.3 },

    latencyBudgetMs: 800,
  },
  {
    id: "C43",
    title: "voice: quiet speech (must still work)",
    category: "voice",
    utterances: ["What time is it?"],

    expect: { tools: ["current_date_time"], micRms: 0.02 },

    latencyBudgetMs: 1200,
  },
  {
    id: "C44",
    title: "voice: interruption then new request",
    category: "voice",
    utterances: ["What's the weather in Delhi?", "Stop. Open Firefox"],

    expect: { tools: ["get_weather", "open_app"], micRms: 0.25 },
  },
  {
    id: "C45",
    title: "voice: repeated identical requests",
    category: "voice",
    utterances: ["What time is it?", "What time is it?", "What time is it?"],

    expect: { tools: ["current_date_time"] },
  },
  {
    id: "C46",
    title: "goodbye: 'thanks bye' ends cleanly",
    category: "conversation",
    utterances: ["Okay that's it for today, thanks bye"],

    expect: { tools: ["end_session"] },
  },
  {
    id: "C47",
    title: "goodbye: hindi 'alvida'",
    category: "conversation",
    utterances: ["अलविदा स्टारफायर"],

    expect: { tools: ["end_session"] },
  },
];
