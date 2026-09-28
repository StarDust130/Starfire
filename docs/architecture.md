# 🔥 Starfire V0 — TODO

### 🏗️ Foundation

* 📁 Project structure
* 🔌 Core interfaces
* ⚙️ Config
* 📝 Logging
* ❌ Error handling
* ✅ Tests + CI

### 🎀 Desktop

* 🪟 Tauri window
* 🐾 Cute character
* 🎭 Character states

### 🎤 Voice

* 🎙️ Microphone capture
* 👂 VAD
* 🤖 LFM2.5-Audio-1.5B S2S
* 🔊 Voice playback
* ⚡ Low-latency interruption / turn-taking

### 🧠 Agent Core

* 💬 Simple conversation
* 🧭 Intent/task detection
* 🔀 Conversation vs task routing

### 🛠️ Tools

* 🚀 `open_app`
* 📖 `read_file`
* ✅ Tool execution
* 🔍 Tool result verification

### 💻 Linux

* 🐧 Linux platform adapter
* 🚀 Open application
* 📖 Read file

### 🔄 End-to-End

* 🎤 Speak
* 🧠 Understand
* 💬 Reply OR 🛠️ act
* 🔍 Verify
* 🔊 Speak result

### ✅ V0 Finish

* 🐛 Error recovery
* 📊 Basic metrics/logs
* 🧪 Real-user tests
* ✨ Polish voice + character



1. contracts   → tool types + manifest
2. tools       → registry + 7 tools + tests (fake executors)
3. core        → agent loop + tests
4. protocol    → function-call parsing + result builder
5. electron    → real executors + voice glue
6. controller  → tolerate tool turns (the "empty response" fix)