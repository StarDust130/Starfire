Starfire Eval — production eval system
Honesty rules (enforced in code)
No fake model decisions. The real model chooses tools via registry.functionTools().
No fake latency/tokens/cost. unknown is shown when the provider doesn't report.
No key → every case BLOCKED (exit 3). Provider error → BLOCKED. Never green.
DeepEval judge is non-gating; deterministic graders own pass/fail.
Rendering crashes can never change results; raw JSONL is persisted per case.
Setup
pnpm installpip install -r eval/python/requirements.txt     # optional, for LLM-judge metricsexport STARFIRE_EVAL_API_KEY=...                # any OpenAI-compatible providerexport STARFIRE_EVAL_BASE_URL=https://api.openai.com/v1   # or OpenRouter/DashScope/localexport STARFIRE_EVAL_MODEL=qwen/qwen3-32b       # pick your real model
Commands
pnpm eval                 # full suite (live model)pnpm eval --verbose       # full traces per casepnpm eval --quiet         # NDJSON to stdoutpnpm eval:fast            # first 40 casespnpm eval:security        # safety + injection + leakagepnpm eval --failed        # show only failurespnpm eval --trials 5      # flaky detection (pass-rate per case)pnpm eval:regression      # compare vs eval/reports/latest.jsonpnpm eval:case C003       # inspect one case from the last runpnpm eval:tools           # registry manifest + policy auditpnpm eval:voice           # honest NOT-FULLY-VERIFIED reportpnpm eval:selftest        # eval tests itself (CI-safe)
Reports
eval/reports/latest.json / .csv / .html   (open .html in a browser = dashboard)eval/reports/runs/<timestamp>/            (immutable raw evidence)
System prompt fidelity
eval/prompts/system.md — paste your REAL voice instructions here.The built-in default is a faithful stand-in, not your production prompt.
Adding a case
Add to eval/src/dataset/seeds.ts (hand cases) or matrices.ts (generated).Self-test validates tools/args/enum against the REAL registry manifests andfails loudly if expectations drift from reality.