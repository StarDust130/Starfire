# 🧪 Starfire V0 Eval

> **Production-style user simulation for Starfire's real agent pipeline.**

**47 real-user scenarios** run through the **actual agent loop → ToolRegistry → tools → ports**.

Only the OS layer is dry-run, so no real windows/apps are opened.

---

## ⚡ Run

```bash
pnpm install
pnpm eval
```

### Quiet mode

```bash
pnpm eval -- --quiet
```

---

## 📊 What It Measures

| Score               | What it checks                                                           |
| :------------------ | :----------------------------------------------------------------------- |
| 🎯 **Tool**         | Did the model choose the correct tool — or correctly choose **no tool**? |
| ✅ **Task**          | Did the selected tool execute successfully?                              |
| 💬 **Quality**      | Is the result useful, complete, and hallucination-free?                  |
| 🛡️ **Reliability** | Any internal errors, crashes, or broken agent loops?                     |
| ⚡ **Latency**       | Are p50 / p95 response times within the target budget?                   |
| 💰 **Cost**         | Simulated token usage priced at production rates                         |

---

## 🧩 Case Coverage

### **47 scenarios**

* 🛠️ **All 12 tools**

  * Normal requests
  * Casual language
  * Hindi
  * Ambiguous requests
  * Invalid requests
  * Tool failures

* 💬 **Pure conversation**

  * Greetings
  * Jokes
  * Math
  * Small talk
  * No-tool traps

* 🪤 **Wrong-tool traps**

  * `"open a conversation"`
  * `"time flies"`

* 🔄 **Multi-turn**

  * Open → close
  * Weather → follow-up
  * Search → summarize

* 🎙️ **Voice scenarios**

  * Fast speech
  * Quiet speech
  * Interruptions
  * Repeated requests

---

## 🖥️ Example Output

```text
──────────────────────────────────────────────────────────

                 🌟 STARFIRE V0 EVAL RESULTS

──────────────────────────────────────────────────────────

Cases       47
✅ Passed    44
❌ Failed     3
Success     93.6%

── category scores ──

🎯 Tool        97%
✅ Task        94%
💬 Quality     91%
🛡️ Reliability 96%

── latency ──

⚡ P50        620ms
⚡ P95       1240ms

── cost (simulated tokens) ──

📥 Tokens     41200 in / 2180 out
💰 Cost       $0.03

── failures ──

❌ C12  ↳ summary missing "opening"
❌ C31  ↳ unnecessary tool call(s): open_app
```

---

## 🧠 Why This Eval Matters

This is **not a unit-test suite**.

The goal is to measure how Starfire behaves when a real user interacts with it.

Every scenario runs through the real:

```text
User Input
    ↓
Agent Loop
    ↓
Model
    ↓
Tool Selection
    ↓
ToolRegistry
    ↓
Tool
    ↓
Port
```

The only mocked layer is the final OS boundary.

That means the evaluation can catch problems that normal tests miss:

* Wrong tool selection
* Unnecessary tool calls
* Missing tool arguments
* Bad validation
* Poor summaries
* Agent-loop failures
* Multi-turn mistakes
* Latency regressions
* Unexpected token/cost growth

---

## 🔍 Failure-Driven Debugging

Every failed scenario identifies **where the pipeline broke**.

```text
Manifest gap
     ↓
Model picks the wrong tool
     ↓
❌ Tool score

Validation gap
     ↓
Bad input reaches the tool
     ↓
❌ Task / Reliability

Tool implementation bug
     ↓
Tool executes incorrectly
     ↓
❌ Task

Poor model response
     ↓
Incomplete / misleading summary
     ↓
❌ Quality
```

So a failure isn't just:

> ❌ Test failed

It's:

> **Which layer caused Starfire to behave incorrectly?**

---

## 💜 The Goal

> **Measure Starfire the way a real user experiences Starfire.**

Repeatable.
Automated.
Production-oriented.
And **free to run**, because the OS boundary is instrumented instead of actually opening windows.

Every failure is feedback for making Starfire more reliable.
