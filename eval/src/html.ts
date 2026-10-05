import type { Scorecard } from "./report.js";
import type { CaseResult } from "./types.js";

export function renderHtml(card: Scorecard, results: CaseResult[]): string {
  const payload = JSON.stringify({ card, cases: results }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Starfire Eval — ${card.runId}</title>
<style>
:root{--bg:#0a0e1a;--panel:#111827;--panel2:#0d1424;--line:#1f2a44;--tx:#e6e9f2;--mut:#8ea0c9;
--grn:#34d399;--red:#f87171;--amb:#fbbf24;--blu:#60a5fa;--teal:#2dd4bf}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
.grid{display:grid;gap:14px}
.hd{display:flex;align-items:center;gap:20px;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px 24px}
.donut{position:relative;width:110px;height:110px;flex:none}
.donut svg{transform:rotate(-90deg)}
.donut .val{position:absolute;inset:0;display:grid;place-items:center;font-size:24px;font-weight:700}
.hd .meta{flex:1;min-width:260px}
.hd h1{font-size:19px;letter-spacing:.02em}
.hd .sub{color:var(--mut);font-size:12.5px;margin-top:4px}
.pills{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.pill{padding:5px 12px;border-radius:999px;font-weight:600;font-size:12.5px;background:var(--panel2);border:1px solid var(--line)}
.pill.g{color:var(--grn)} .pill.r{color:var(--red)} .pill.b{color:var(--blu)} .pill.a{color:var(--amb)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.card h2{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}
.two{grid-template-columns:1fr 1fr} .four{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.stat .n{font-size:22px;font-weight:700} .stat .l{color:var(--mut);font-size:12px}
.finding{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line);align-items:baseline}
.finding:first-of-type{border-top:0}
.sev{flex:none;font-weight:700;font-size:11px;padding:2px 8px;border-radius:6px}
.sev.P0{background:#450a0a;color:#fca5a5}.sev.P1{background:#451a03;color:#fcd34d}.sev.P2{background:#1e3a5f;color:#93c5fd}
.cat{margin:9px 0}.cat .row{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px}
.track{height:8px;border-radius:4px;background:var(--panel2);overflow:hidden}
.fill{height:100%;border-radius:4px;background:var(--teal)}
.fill.mid{background:var(--amb)} .fill.low{background:var(--red)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12.5px}
.chip b{color:var(--teal)}
.tblwrap{overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--mut);text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;cursor:pointer;user-select:none;white-space:nowrap;border-bottom:1px solid var(--line)}
th:hover{color:var(--tx)}
td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
tr.case{cursor:pointer} tr.case:hover{background:var(--panel2)}
.st{font-weight:700;font-size:11px;padding:2px 9px;border-radius:6px}
.st.pass{background:#052e1b;color:var(--grn)} .st.fail{background:#3f0d0d;color:var(--red)} .st.blocked{background:#12294a;color:var(--blu)}
.filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.filters input,.filters select{background:var(--panel2);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:7px 11px;font-size:13px;outline:none}
.filters input:focus,.filters select:focus{border-color:var(--teal)}
.fbtn{background:var(--panel2);border:1px solid var(--line);color:var(--mut);border-radius:8px;padding:7px 12px;font-size:12.5px;cursor:pointer;font-weight:600}
.fbtn.on{color:var(--bg);background:var(--teal);border-color:var(--teal)}
.overlay{position:fixed;inset:0;background:rgba(4,7,15,.6);backdrop-filter:blur(2px);display:none;z-index:40}
.drawer{position:fixed;top:0;right:-640px;width:min(640px,94vw);height:100vh;background:var(--panel);border-left:1px solid var(--line);z-index:50;transition:right .18s ease;overflow-y:auto;padding:22px}
.drawer.open{right:0}
.drawer h3{font-size:16px;margin-bottom:4px}
.dsec{margin-top:16px}.dsec h4{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
.bub{padding:8px 12px;border-radius:10px;margin:5px 0;font-size:13px;max-width:92%}
.bub.user{background:#12294a;border:1px solid #1d3a63}
.bub.assistant{background:#0b2b22;border:1px solid #14532d}
.bub.tool{background:var(--panel2);border:1px solid var(--line);color:var(--mut);font-family:ui-monospace,monospace;font-size:12px}
.tcall{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:7px 0;font-size:12.5px}
.tcall .h{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
.tcall pre{white-space:pre-wrap;word-break:break-all;color:var(--mut);font-size:11.5px;margin-top:4px}
.okb{font-weight:700;font-size:11px;padding:2px 8px;border-radius:6px}
.okb.y{background:#052e1b;color:var(--grn)} .okb.n{background:#3f0d0d;color:var(--red)} .okb.s{background:#12294a;color:var(--blu)}
.diffrow{font-family:ui-monospace,monospace;font-size:12px;padding:6px 0;border-top:1px solid var(--line)}
.diffrow .b{color:var(--red)} .diffrow .a{color:var(--grn)}
.grade{display:flex;gap:9px;padding:5px 0;font-size:12.5px;align-items:baseline}
.grade .m{font-weight:600;min-width:170px}
.gmark{font-weight:700} .gmark.y{color:var(--grn)} .gmark.n{color:var(--red)}
.latbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--panel2);margin-top:6px}
.close{position:absolute;top:14px;right:16px;background:var(--panel2);border:1px solid var(--line);color:var(--mut);width:32px;height:32px;border-radius:8px;font-size:16px;cursor:pointer}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.warnline{font-weight:700;margin-top:10px}
@media(max-width:860px){.two{grid-template-columns:1fr}}
</style></head><body>

<div class="hd">
  <div class="donut"><svg width="110" height="110"><circle cx="55" cy="55" r="48" fill="none" stroke="#1f2a44" stroke-width="11"/>
  <circle id="arc" cx="55" cy="55" r="48" fill="none" stroke="#2dd4bf" stroke-width="11" stroke-linecap="round" stroke-dasharray="0 302"/></svg>
  <div class="val" id="pct">–</div></div>
  <div class="meta">
    <h1>STARFIRE EVAL <span style="color:var(--mut);font-weight:400" id="runid"></span></h1>
    <div class="sub" id="metasub"></div>
    <div class="pills" id="pills"></div>
  </div>
</div>

<div class="card" style="margin-top:14px" id="quotaCard" hidden>
  <h2>EmpirioLabs quota — ACTUAL vs PROJECTED</h2>
  <div class="chips" id="quotaChips"></div>
  <div class="warnline" id="quotaWarn"></div>
</div>

<div class="grid four" style="margin-top:14px" id="stats"></div>

<div class="grid two" style="margin-top:14px">
  <div class="card"><h2>Findings</h2><div id="findings"></div></div>
  <div class="card"><h2>Category scores</h2><div id="cats"></div></div>
</div>

<div class="grid two" style="margin-top:14px">
  <div class="card"><h2>Metrics</h2><div class="chips" id="metrics"></div></div>
  <div class="card"><h2>Performance &amp; usage (ACTUAL)</h2><div id="perf"></div></div>
</div>

<div class="card" style="margin-top:14px">
  <h2>Cases — click any row for full trace</h2>
  <div class="filters">
    <input id="q" placeholder="Search id / title / root cause…" style="flex:1;min-width:200px">
    <select id="catSel"><option value="">All categories</option></select>
    <button class="fbtn on" data-st="">All</button>
    <button class="fbtn" data-st="pass">Pass</button>
    <button class="fbtn" data-st="fail">Fail</button>
    <button class="fbtn" data-st="blocked">Blocked</button>
  </div>
  <div class="tblwrap"><table>
    <thead><tr>
      <th data-k="caseId">ID</th><th data-k="title">Title</th><th data-k="category">Category</th>
      <th data-k="status">Status</th><th data-k="severity">Sev</th><th data-k="rootCause">Root cause</th>
      <th data-k="ms">Time</th><th data-k="tok">Tokens</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table></div>
</div>

<div class="overlay" id="ov"></div>
<aside class="drawer" id="drawer">
  <button class="close" id="cl">✕</button>
  <div id="dbody"></div>
</aside>

<script id="evaldata" type="application/json">${payload}</script>
<script>
const DATA = JSON.parse(document.getElementById("evaldata").textContent);
const C = DATA.cases, K = DATA.card;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const fmtN = (n) => Math.round(n).toLocaleString("en-US");

// header
const executed = Math.max(1, K.total - K.blocked - (K.skipped || 0));
const pct = Math.round((K.passed / executed) * 100);
 $("pct").textContent = pct + "%";
const arc = $("arc"); const len = 2 * Math.PI * 48;
arc.setAttribute("stroke-dasharray", (pct / 100) * len + " " + len);
arc.setAttribute("stroke", pct >= 90 ? "#34d399" : pct >= 70 ? "#fbbf24" : "#f87171");
 $("runid").textContent = "· " + K.runId;
 $("metasub").textContent = K.model + " @ " + K.provider + " · commit " + K.gitCommit + " · " + K.timestamp + " · dataset " + K.datasetVersion;
const pills = $("pills");
[["✅ " + K.passed + " passed","g"],["❌ " + K.failed + " failed","r"],["⛔ " + K.blocked + " blocked","b"],
 (K.skipped ? ["⏭ " + K.skipped + " skipped (budget guard)","a"] : null),
 ["P0 " + K.severities.P0,"r"],["P1 " + K.severities.P1,"r"],["P2 " + K.severities.P2,"a"],["P3 " + K.severities.P3,""]]
 .filter(Boolean).forEach((p) => { const s = el("span", "pill " + p[1], p[0]); pills.appendChild(s); });

// quota card (ACTUAL vs PROJECTED — never mixed)
if (K.quota) {
  $("quotaCard").hidden = false;
  const q = K.quota;
  const items = [
    ["Plan", q.plan ?? "unknown"],
    ["Balance", q.balance ?? "unknown"],
    ["Account usage", q.accountTokens != null ? fmtN(q.accountTokens) + " tok" : "unknown"],
    ["Run ACTUAL", fmtN(q.runActualTokens) + " tok"],
    ["Run budget", fmtN(q.runBudgetTokens) + " tok"],
    ["Run PROJECTED (full)", fmtN(q.projectedFullRunTokens) + " tok"],
    ["Cost ACTUAL", q.runActualCostUsd != null ? "$" + q.runActualCostUsd.toFixed(4) : "UNKNOWN"],
    ["Cost PROJECTED", q.projectedFullRunCostUsd != null ? "$" + q.projectedFullRunCostUsd.toFixed(2) : "UNKNOWN"],
    ["RPM target", q.maxRpm + " / " + q.rpmLimitOfficial + " official"],
    ["TPM target", fmtN(q.maxTpm) + " / " + fmtN(q.tpmLimitOfficial)],
    ["Trials", String(q.trials)],
  ];
  const qc = $("quotaChips");
  for (const it of items) { const ch = el("span", "chip"); ch.appendChild(el("b", null, String(it[1]))); ch.appendChild(document.createTextNode(" " + it[0])); qc.appendChild(ch); }
  const w = $("quotaWarn");
  const map = {
    "SAFE": ["🟢 SAFE", "var(--grn)"],
    "LOW BUDGET": ["🟡 LOW BUDGET", "var(--amb)"],
    "WOULD EXCEED SAFE BUDGET": ["🔴 WOULD EXCEED SAFE BUDGET", "var(--red)"],
    "BLOCKED": ["⛔ BLOCKED", "var(--red)"],
  };
  const m = map[q.status] ?? [q.status, "var(--mut)"];
  w.textContent = m[0]; w.style.color = m[1];
  if (q.pricingSource) { const ps = el("div", "sub", "pricing source: " + q.pricingSource); w.appendChild(ps); }
  if (K.stoppedEarly) { const s = el("div", "sub", "Stopped safely: " + K.stoppedEarly); w.appendChild(s); }
}

// stat cards
const stats = [
  ["Overall", K.overallScore + "%"],
  ["p50 latency", Math.round(K.latency.p50) + " ms"],
  ["p95 latency", Math.round(K.latency.p95) + " ms"],
  ["p99 latency", Math.round(K.latency.p99) + " ms"],
  ["Tokens in", String(K.usage.input)],
  ["Tokens out", String(K.usage.output)],
  ["Cost", K.usage.cost],
  ["Total cases", String(K.total)],
];
 $("stats").innerHTML = "";
for (const s of stats) {
  const d = el("div", "card stat");
  d.appendChild(el("div", "n", s[1])); d.appendChild(el("div", "l", s[0]));
  $("stats").appendChild(d);
}

// findings
const F = $("findings"); F.innerHTML = "";
if (!K.findings.length) F.appendChild(el("div", "sub", "No findings — nothing failed and no static issues detected."));
for (const f of K.findings) {
  const row = el("div", "finding");
  row.appendChild(el("span", "sev " + f.level, f.level));
  const txt = el("span", null, f.text);
  if (f.caseId) txt.appendChild(el("b", null, " " + f.caseId));
  row.appendChild(txt);
  F.appendChild(row);
}

// categories
const CC = $("cats"); CC.innerHTML = "";
if (!Object.keys(K.categories).length) CC.appendChild(el("div", "sub", "No executed cases — everything blocked or skipped."));
for (const k of Object.keys(K.categories)) {
  const v = K.categories[k]; const s = v.score ?? 0;
  const wrap = el("div", "cat");
  const row = el("div", "row");
  row.appendChild(el("span", null, k));
  row.appendChild(el("b", null, (v.score ?? "n/a") + "%"));
  wrap.appendChild(row);
  const tr = el("div", "track"); const fi = el("div", "fill" + (s < 70 ? " low" : s < 90 ? " mid" : ""));
  fi.style.width = s + "%"; tr.appendChild(fi); wrap.appendChild(tr);
  CC.appendChild(wrap);
}

// metrics
const M = $("metrics"); M.innerHTML = "";
for (const k of Object.keys(K.metrics)) {
  const v = K.metrics[k];
  const chip = el("span", "chip");
  chip.appendChild(el("b", null, (v.score ?? "n/a") + "%"));
  chip.appendChild(document.createTextNode(" " + k + " (" + v.n + ")"));
  M.appendChild(chip);
}

// perf (ACTUAL)
const P = $("perf"); P.innerHTML = "";
const perfRows = [["mean", K.latency.mean],["min", K.latency.min],["p50", K.latency.p50],["p75", K.latency.p75],["p90", K.latency.p90],["p95", K.latency.p95],["p99", K.latency.p99],["max", K.latency.max]];
for (const r2 of perfRows) {
  const row = el("div", "diffrow");
  row.appendChild(el("span", "b", r2[0].padEnd(5)));
  row.appendChild(document.createTextNode(" " + Math.round(r2[1]) + " ms"));
  P.appendChild(row);
}
P.appendChild(el("div", "sub", "tokens in " + K.usage.input + " · out " + K.usage.output + " · cost " + K.usage.cost));

// case table
let stFilter = "", catFilter = "", q2 = "", sortK = "caseId", sortDir = 1;
const catSel = $("catSel");
[...new Set(C.map(c => c.category))].sort().forEach(c2 => { const o = el("option", null, c2); o.value = c2; catSel.appendChild(o); });
catSel.onchange = () => { catFilter = catSel.value; draw(); };
document.querySelectorAll(".fbtn").forEach(b => b.onclick = () => {
  document.querySelectorAll(".fbtn").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); stFilter = b.dataset.st; draw();
});
 $("q").oninput = () => { q2 = $("q").value.toLowerCase(); draw(); };
document.querySelectorAll("th[data-k]").forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  if (sortK === k) sortDir = -sortDir; else { sortK = k; sortDir = 1; }
  draw();
});
const val = (c, k) => {
  if (k === "ms") return Math.round(c.durationMs);
  if (k === "tok") return c.tokens.total ?? -1;
  return c[k] ?? "";
};
function draw() {
  const tb = $("tbody"); tb.innerHTML = "";
  let rows = C.filter(c =>
    (!stFilter || c.status === stFilter) &&
    (!catFilter || c.category === catFilter) &&
    (!q2 || (c.caseId + " " + c.title + " " + (c.rootCause || "") + " " + c.tags.join(" ")).toLowerCase().includes(q2))
  );
  rows = rows.sort((a, b) => { const x = val(a, sortK), y = val(b, sortK); return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
  for (const c of rows) {
    const tr = el("tr", "case");
    tr.appendChild(el("td", "mono", c.caseId));
    const tt = el("td"); tt.textContent = c.title.length > 58 ? c.title.slice(0, 58) + "…" : c.title; tt.style.whiteSpace = "normal"; tr.appendChild(tt);
    tr.appendChild(el("td", null, c.category));
    const st = el("td"); st.appendChild(el("span", "st " + c.status, c.status)); tr.appendChild(st);
    tr.appendChild(el("td", null, c.severity || "–"));
    tr.appendChild(el("td", null, c.rootCause || "–"));
    tr.appendChild(el("td", "mono", Math.round(c.durationMs) + " ms"));
    tr.appendChild(el("td", "mono", c.tokens.total != null ? String(c.tokens.total) : "unknown"));
    tr.onclick = () => openCase(c);
    tb.appendChild(tr);
  }
  if (!rows.length) { const tr = el("tr"); const td = el("td", "sub", "No cases match."); td.colSpan = 8; tr.appendChild(td); tb.appendChild(tr); }
}
draw();

// drawer
function section(title) { const d = el("div", "dsec"); d.appendChild(el("h4", null, title)); return d; }
function openCase(c) {
  const b = $("dbody"); b.innerHTML = "";
  b.appendChild(el("h3", null, c.caseId + " — " + c.title));
  const meta = el("div", "sub", c.category + " · " + c.status + (c.severity ? " · " + c.severity : "") + (c.rootCause ? " · root cause: " + c.rootCause : "") + (c.retries ? " · retries: " + c.retries : ""));
  b.appendChild(meta);
  if (c.blockedReason) { const br = el("p", null, c.blockedReason); br.style.marginTop = "8px"; br.style.fontSize = "13px"; b.appendChild(br); }
  else if (c.explanation) { const ex = el("p", null, c.explanation); ex.style.marginTop = "8px"; ex.style.fontSize = "13px"; b.appendChild(ex); }

  const s1 = section("Transcript");
  for (const t of c.transcript) s1.appendChild(el("div", "bub " + t.role, t.content));
  b.appendChild(s1);

  const s2 = section("Tool calls (" + c.toolCalls.length + ")");
  if (!c.toolCalls.length) s2.appendChild(el("div", "sub", "No tool calls."));
  for (const t of c.toolCalls) {
    const card2 = el("div", "tcall");
    const hrow = el("div", "h");
    hrow.appendChild(el("b", null, "#" + t.index + " " + t.tool));
    const badge = t.ok === true ? el("span", "okb y", "ok") : t.ok === false ? el("span", "okb n", "error") : el("span", "okb s", "skipped");
    hrow.appendChild(badge);
    card2.appendChild(hrow);
    card2.appendChild(el("pre", null, "args: " + JSON.stringify(t.parsedArgs) + (t.rawArgs ? "\\nraw:  " + t.rawArgs : "")));
    if (t.summary) card2.appendChild(el("pre", null, "↳ " + t.summary));
    if (t.error) card2.appendChild(el("pre", null, "error: " + t.error));
    if (t.validation && !t.validation.ok) card2.appendChild(el("pre", null, "validation: " + t.validation.errors.join("; ")));
    s2.appendChild(card2);
  }
  b.appendChild(s2);

  const s3 = section("State diff");
  const d = c.stateDiff;
  if (!d || !Object.keys(d).length) s3.appendChild(el("div", "sub", "No state change."));
  else for (const k2 of Object.keys(d)) {
    const v = d[k2];
    const row = el("div", "diffrow");
    row.appendChild(el("span", null, k2 + ": "));
    row.appendChild(el("span", "b", JSON.stringify(v.before)));
    row.appendChild(document.createTextNode(" → "));
    row.appendChild(el("span", "a", JSON.stringify(v.after)));
    s3.appendChild(row);
  }
  b.appendChild(s3);

  const s4 = section("Metrics / grades");
  for (const g of c.grades) {
    const gr = el("div", "grade");
    gr.appendChild(el("span", "gmark " + (g.passed ? "y" : "n"), g.passed ? "✓" : "✗"));
    gr.appendChild(el("span", "m", g.metric));
    gr.appendChild(el("span", null, (g.score ?? "–") + " — " + g.reason));
    s4.appendChild(gr);
  }
  b.appendChild(s4);

  const s5 = section("Performance");
  const tot = Math.max(1, c.latency.modelMs + c.latency.toolMs);
  const lb = el("div", "latbar");
  const m1 = el("div"); m1.style.width = (c.latency.modelMs / tot * 100) + "%"; m1.style.background = "#2dd4bf";
  const m2 = el("div"); m2.style.width = (c.latency.toolMs / tot * 100) + "%"; m2.style.background = "#60a5fa";
  lb.appendChild(m1); lb.appendChild(m2); s5.appendChild(lb);
  s5.appendChild(el("div", "sub", "total " + (c.durationMs / 1000).toFixed(2) + "s · model " + Math.round(c.latency.modelMs) + "ms · tools " + Math.round(c.latency.toolMs) + "ms · llm cycles " + c.latency.llmIterations + " · retries " + (c.retries ?? 0) + " · tokens " + (c.tokens.total != null ? fmtN(c.tokens.total) : "unknown") + " · cost " + (c.costUsd != null ? "$" + c.costUsd.toFixed(5) : "unknown")));
  b.appendChild(s5);

  $("drawer").classList.add("open"); $("ov").style.display = "block";
}
function closeCase() { $("drawer").classList.remove("open"); $("ov").style.display = "none"; }
 $("cl").onclick = closeCase; $("ov").onclick = closeCase;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCase(); });
</script>
</body></html>`;
}
