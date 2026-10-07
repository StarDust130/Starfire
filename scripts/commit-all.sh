```bash
#!/usr/bin/env bash

set -uE -o pipefail

# ═══════════════════════════════════════════════════════════════
# 🌌 STARFIRE SMART COMMIT
#
#   FORMAT ONCE
#      ↓
#   GLOBAL CHECKS ONCE
#      ↓
#   FIND WHICH FILES ACTUALLY HAVE PROBLEMS
#      ↓
#   VALIDATE ONLY WHEN NEEDED
#      ↓
#   COMMIT EACH GOOD FILE SEPARATELY
#
#   ✅ Good file  → commit
#   ❌ Bad file   → skip
#   📚 Markdown   → accepted
#   🐚 Shell      → bash -n + ShellCheck
#   🧹 Code       → Biome
#
#   Lefthook is intentionally skipped on individual commits
#   because the checks already ran above.
# ═══════════════════════════════════════════════════════════════

ROOT="$(git rev-parse --show-toplevel)" || {
  echo "❌ Not inside a Git repository."
  exit 1
}

cd "$ROOT"

# ───────────────────────────────────────────────────────────────
# 🎨 TUI colors
# ───────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  RESET=$'\033[0m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'

  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  MAGENTA=$'\033[35m'
  CYAN=$'\033[36m'
  WHITE=$'\033[37m'
else
  RESET=""
  BOLD=""
  DIM=""

  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  MAGENTA=""
  CYAN=""
  WHITE=""
fi

# ───────────────────────────────────────────────────────────────
# 🎲 Emoji pools
# ───────────────────────────────────────────────────────────────

FEAT_EMOJIS=(
  "🚀" "✨" "🌌" "⚡" "💫"
  "🛸" "🌠" "🔥" "🎨" "🪐"
)

FIX_EMOJIS=(
  "🛡️" "🔐" "🧩" "🔧" "🛠️"
  "⚙️" "🚧" "🧠" "🔥" "🪄"
)

TEST_EMOJIS=(
  "🧪" "🔬" "🎯" "🔎" "🧬"
  "🕵️" "📊" "🧭" "🧫" "🧰"
)

DOCS_EMOJIS=(
  "📚" "📝" "📖" "🗺️" "✍️"
  "🪶" "📜" "💡" "🧾" "📰"
)

CHORE_EMOJIS=(
  "🧹" "🛠️" "⚙️" "🔩" "🧰"
  "🪛" "🔨" "🧱" "🗂️" "🔧"
)

declare -A USED_EMOJIS=()

# ───────────────────────────────────────────────────────────────
# 💬 Cool commit subject pools
# ───────────────────────────────────────────────────────────────

FIX_SUBJECTS=(
  "tighten the execution flow"
  "harden the rough edges"
  "make the agent path safer"
  "polish the runtime behavior"
  "stabilize the moving parts"
  "lock down tool behavior"
  "clean up the execution path"
  "strengthen the agent boundary"
)

TEST_SUBJECTS=(
  "sharpen regression coverage"
  "strengthen the safety net"
  "expand agent coverage"
  "tighten regression checks"
  "make failures easier to catch"
  "improve confidence in the flow"
  "cover the tricky paths"
  "add sharper guardrails"
)

DOC_SUBJECTS=(
  "refresh the Starfire map"
  "clean up the project docs"
  "align docs with the code"
  "refresh the architecture notes"
  "make the project easier to navigate"
  "polish the developer docs"
  "clean up the project story"
  "bring the docs up to date"
)

FEAT_SUBJECTS=(
  "make the experience smoother"
  "level up the Starfire experience"
  "polish the interaction flow"
  "make the companion feel better"
  "expand the desktop experience"
  "smooth out the realtime flow"
  "upgrade the companion experience"
  "push the experience forward"
)

CHORE_SUBJECTS=(
  "level up the developer workflow"
  "clean up the project workflow"
  "polish the developer experience"
  "tighten project maintenance"
  "make the workflow smoother"
  "clean up the moving parts"
  "improve the project machinery"
  "keep Starfire tidy"
)

# ───────────────────────────────────────────────────────────────
# 🧰 UI helpers
# ───────────────────────────────────────────────────────────────

header() {
  local title="$1"

  echo ""
  echo "${CYAN}${BOLD}╭────────────────────────────────────────────────╮${RESET}"
  printf "${CYAN}${BOLD}│ %-46s │${RESET}\n" "$title"
  echo "${CYAN}${BOLD}╰────────────────────────────────────────────────╯${RESET}"
  echo ""
}

ok() {
  echo "${GREEN}✅ $1${RESET}"
}

fail() {
  echo "${RED}❌ $1${RESET}"
}

warn() {
  echo "${YELLOW}⚠️  $1${RESET}"
}

info() {
  echo "${BLUE}ℹ️  $1${RESET}"
}

skip() {
  echo "${YELLOW}⏭️  $1${RESET}"
}

command_line() {
  echo "${DIM}┌─ $ $*${RESET}"
}

# ───────────────────────────────────────────────────────────────
# 🎲 Random non-repeating emoji
# ───────────────────────────────────────────────────────────────

pick_emoji() {
  local type="$1"
  local -a pool
  local -a available
  local emoji
  local index

  case "$type" in
    feat)
      pool=("${FEAT_EMOJIS[@]}")
      ;;
    fix)
      pool=("${FIX_EMOJIS[@]}")
      ;;
    test)
      pool=("${TEST_EMOJIS[@]}")
      ;;
    docs)
      pool=("${DOCS_EMOJIS[@]}")
      ;;
    chore|*)
      pool=("${CHORE_EMOJIS[@]}")
      ;;
  esac

  available=()

  for emoji in "${pool[@]}"; do
    if [[ "${USED_EMOJIS[$emoji]:-0}" -eq 0 ]]; then
      available+=("$emoji")
    fi
  done

  # Recycle only after every emoji in the pool was used.
  if [[ "${#available[@]}" -eq 0 ]]; then
    for emoji in "${pool[@]}"; do
      unset 'USED_EMOJIS[$emoji]'
    done

    available=("${pool[@]}")
  fi

  index=$((RANDOM % ${#available[@]}))
  emoji="${available[$index]}"

  USED_EMOJIS["$emoji"]=1

  printf "%s" "$emoji"
}

# ───────────────────────────────────────────────────────────────
# 🎲 Random subject
# ───────────────────────────────────────────────────────────────

random_subject() {
  local type="$1"
  local -a pool
  local index

  case "$type" in
    fix)
      pool=("${FIX_SUBJECTS[@]}")
      ;;
    test)
      pool=("${TEST_SUBJECTS[@]}")
      ;;
    docs)
      pool=("${DOC_SUBJECTS[@]}")
      ;;
    feat)
      pool=("${FEAT_SUBJECTS[@]}")
      ;;
    chore|*)
      pool=("${CHORE_SUBJECTS[@]}")
      ;;
  esac

  index=$((RANDOM % ${#pool[@]}))

  printf "%s" "${pool[$index]}"
}

# ───────────────────────────────────────────────────────────────
# 📝 Commit metadata
# ───────────────────────────────────────────────────────────────

commit_message_for_file() {
  local file="$1"

  local type="chore"
  local scope="project"
  local subject="update Starfire"

  case "$file" in
    eval/*)
      type="test"
      scope="eval"
      subject="improve agent evaluation"
      ;;

    *.test.*|*.spec.*|*/test/*|*/tests/*)
      type="test"
      scope="tests"
      subject="$(random_subject test)"
      ;;

    docs/*|*.md)
      type="docs"
      scope="docs"
      subject="$(random_subject docs)"
      ;;

    packages/contracts/*)
      type="fix"
      scope="contracts"
      subject="strengthen shared contracts"
      ;;

    packages/tools/*)
      type="fix"
      scope="tools"

      case "$file" in
        */policy.ts|*/registry.ts)
          subject="lock down tool safety"
          ;;
        */validate.ts)
          subject="tighten tool validation"
          ;;
        *)
          subject="$(random_subject fix)"
          ;;
      esac
      ;;

    apps/core/*)
      type="fix"
      scope="core"

      case "$file" in
        */agent-runner.ts)
          subject="tighten agent execution"
          ;;
        *)
          subject="$(random_subject fix)"
          ;;
      esac
      ;;

    apps/desktop/electron/*)
      type="fix"
      scope="electron"

      case "$file" in
        */realtimeVoice.ts)
          subject="smooth out realtime voice"
          ;;
        */agent/*)
          subject="harden the desktop agent bridge"
          ;;
        *)
          subject="$(random_subject fix)"
          ;;
      esac
      ;;

    apps/desktop/src/voice/*)
      type="feat"
      scope="voice"
      subject="$(random_subject feat)"
      ;;

    apps/desktop/src/three/*)
      type="feat"
      scope="ui"
      subject="$(random_subject feat)"
      ;;

    apps/desktop/*)
      type="feat"
      scope="desktop"
      subject="$(random_subject feat)"
      ;;

    scripts/*)
      type="chore"
      scope="scripts"
      subject="$(random_subject chore)"
      ;;

    package.json|pnpm-lock.yaml|biome.json|biome.jsonc|lefthook.yml)
      type="chore"
      scope="project"
      subject="$(random_subject chore)"
      ;;
  esac

  local emoji
  emoji="$(pick_emoji "$type")"

  printf "%s %s(%s): %s" \
    "$emoji" \
    "$type" \
    "$scope" \
    "$subject"
}

# ───────────────────────────────────────────────────────────────
# 🔎 Log attribution
# ───────────────────────────────────────────────────────────────

log_mentions_file() {
  local log="$1"
  local file="$2"

  [[ -s "$log" ]] || return 1

  grep -Fq -- "$file" "$log" ||
    grep -Fq -- "./$file" "$log"
}

# ───────────────────────────────────────────────────────────────
# 🧹 File checker
# ───────────────────────────────────────────────────────────────

check_file() {
  local file="$1"

  case "$file" in
    # TypeScript / JavaScript
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
      command_line "pnpm exec biome check \"$file\""

      if pnpm exec biome check "$file"; then
        ok "Code check passed"
        return 0
      fi

      fail "Code check failed"
      return 1
      ;;

    # JSON
    *.json|*.jsonc)
      command_line "pnpm exec biome check \"$file\""

      if pnpm exec biome check "$file"; then
        ok "Config check passed"
        return 0
      fi

      fail "Config check failed"
      return 1
      ;;

    # CSS
    *.css)
      command_line "pnpm exec biome check \"$file\""

      if pnpm exec biome check "$file"; then
        ok "Style check passed"
        return 0
      fi

      fail "Style check failed"
      return 1
      ;;

    # Bash
    *.sh)
      command_line "bash -n \"$file\""

      if ! bash -n "$file"; then
        fail "Bash syntax failed"
        return 1
      fi

      ok "Bash syntax passed"

      if command -v shellcheck >/dev/null 2>&1; then
        command_line "shellcheck \"$file\""

        if ! shellcheck "$file"; then
          fail "ShellCheck failed"
          return 1
        fi

        ok "ShellCheck passed"
      else
        info "ShellCheck not installed — bash syntax check is used."
      fi

      return 0
      ;;

    # Markdown
    *.md)
      info "Markdown has no source-code lint in this workflow."
      ok "Documentation accepted"
      return 0
      ;;

    # Images / lockfiles / other assets
    *)
      info "No file-specific checker needed."
      ok "Global checks are sufficient"
      return 0
      ;;
  esac
}

# ───────────────────────────────────────────────────────────────
# ▶️ Run a global command and save its output
# ───────────────────────────────────────────────────────────────

run_global() {
  local label="$1"
  local log_file="$2"
  shift 2

  echo ""
  echo "${BOLD}${WHITE}▶ $label${RESET}"
  command_line "$@"

  "$@" 2>&1 | tee "$log_file"

  local status="${PIPESTATUS[0]}"

  echo ""

  if [[ "$status" -eq 0 ]]; then
    ok "$label passed"
  else
    fail "$label failed"
  fi

  return "$status"
}

# ═══════════════════════════════════════════════════════════════
# 🚀 START
# ═══════════════════════════════════════════════════════════════

header "🌌 Starfire Smart Commit"

echo "${BOLD}Repository${RESET}  $ROOT"
echo "${BOLD}Branch${RESET}     $(git branch --show-current)"
echo "${BOLD}Started${RESET}    $(date '+%H:%M:%S')"

# ───────────────────────────────────────────────────────────────
# 🎨 Format
# ───────────────────────────────────────────────────────────────

header "🎨 Format"

run_global "Biome format" /dev/null pnpm format

if [[ "$?" -ne 0 ]]; then
  fail "Formatting failed — stopping."
  exit 1
fi

# ───────────────────────────────────────────────────────────────
# 📦 Stage
# ───────────────────────────────────────────────────────────────

header "📦 Stage changes"

git add -A

if git diff --cached --quiet; then
  info "Working tree is clean. Nothing to commit."
  exit 0
fi

mapfile -d '' -t FILES < <(
  git diff --cached --name-only -z
)

FILE_COUNT="${#FILES[@]}"

echo "${BOLD}Changed files: ${WHITE}${FILE_COUNT}${RESET}"
echo ""

for file in "${FILES[@]}"; do
  echo "  ├─ $file"
done

# ───────────────────────────────────────────────────────────────
# 🧪 Global checks
# ───────────────────────────────────────────────────────────────

header "🧪 Global checks"

TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

DIFF_LOG="$TMP_DIR/diff.log"
LINT_LOG="$TMP_DIR/lint.log"
TYPECHECK_LOG="$TMP_DIR/typecheck.log"
TEST_LOG="$TMP_DIR/test.log"

GLOBAL_DIFF_OK=true
GLOBAL_LINT_OK=true
GLOBAL_TYPECHECK_OK=true
GLOBAL_TEST_OK=true

# Git diff
run_global "Git diff check" "$DIFF_LOG" git diff --cached --check ||
  GLOBAL_DIFF_OK=false

# Lint
run_global "Biome lint" "$LINT_LOG" pnpm lint ||
  GLOBAL_LINT_OK=false

# Typecheck
run_global "TypeScript typecheck" "$TYPECHECK_LOG" pnpm typecheck ||
  GLOBAL_TYPECHECK_OK=false

# Tests
run_global "Test suite" "$TEST_LOG" pnpm test ||
  GLOBAL_TEST_OK=false

# ───────────────────────────────────────────────────────────────
# 📊 Global summary
# ───────────────────────────────────────────────────────────────

header "📊 Global health"

if [[ "$GLOBAL_DIFF_OK" == true ]]; then
  echo "  ${GREEN}●${RESET} Git diff       ${GREEN}PASS${RESET}"
else
  echo "  ${RED}●${RESET} Git diff       ${RED}FAIL${RESET}"
fi

if [[ "$GLOBAL_LINT_OK" == true ]]; then
  echo "  ${GREEN}●${RESET} Biome          ${GREEN}PASS${RESET}"
else
  echo "  ${RED}●${RESET} Biome          ${RED}FAIL${RESET}"
fi

if [[ "$GLOBAL_TYPECHECK_OK" == true ]]; then
  echo "  ${GREEN}●${RESET} TypeScript     ${GREEN}PASS${RESET}"
else
  echo "  ${RED}●${RESET} TypeScript     ${RED}FAIL${RESET}"
fi

if [[ "$GLOBAL_TEST_OK" == true ]]; then
  echo "  ${GREEN}●${RESET} Tests          ${GREEN}PASS${RESET}"
else
  echo "  ${RED}●${RESET} Tests          ${RED}FAIL${RESET}"
fi

echo ""

# ───────────────────────────────────────────────────────────────
# 🚀 Individual files
# ───────────────────────────────────────────────────────────────

header "🚀 Individual commits"

COMMITTED=0
SKIPPED=0
INDEX=0

for file in "${FILES[@]}"; do
  INDEX=$((INDEX + 1))

  echo ""
  echo "${MAGENTA}${BOLD}╭─ [$INDEX/$FILE_COUNT] $file${RESET}"
  echo ""

  STATUS="$(
    git diff --cached --name-status -- "$file" |
      awk 'NR == 1 { print $1 }'
  )"

  BLOCKED=false

  # ───────────────────────────────────────────────────────────
  # Deleted file
  # ───────────────────────────────────────────────────────────

  if [[ "$STATUS" == "D" ]]; then
    info "Deleted file — no content check needed."

  else
    # ─────────────────────────────────────────────────────────
    # Diff failure
    # ─────────────────────────────────────────────────────────

    if [[ "$GLOBAL_DIFF_OK" == false ]] &&
      log_mentions_file "$DIFF_LOG" "$file"; then
      error "Git diff check points to this file."
      BLOCKED=true
    fi

    # ─────────────────────────────────────────────────────────
    # Lint failure
    #
    # If global lint failed and points to this file, run an exact
    # file check so unrelated files can still be committed.
    # ─────────────────────────────────────────────────────────

    if [[ "$GLOBAL_LINT_OK" == false ]]; then
      if log_mentions_file "$LINT_LOG" "$file"; then
        error "Global lint points to this file."
        BLOCKED=true
      elif [[ "$file" =~ \.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$ ]]; then
        info "Global lint failed elsewhere. Checking this file directly..."

        if ! check_file "$file"; then
          BLOCKED=true
        fi
      fi
    fi

    # ─────────────────────────────────────────────────────────
    # Typecheck failure
    # ─────────────────────────────────────────────────────────

    if [[ "$GLOBAL_TYPECHECK_OK" == false ]] &&
      log_mentions_file "$TYPECHECK_LOG" "$file"; then
      error "Typecheck points to this file."
      BLOCKED=true
    fi

    # ─────────────────────────────────────────────────────────
    # Test failure
    # ─────────────────────────────────────────────────────────

    if [[ "$GLOBAL_TEST_OK" == false ]] &&
      log_mentions_file "$TEST_LOG" "$file"; then
      error "Tests point to this file."
      BLOCKED=true
    fi

    # If everything globally passed, run only the file-specific
    # validation that global checks do not provide.
    if [[ "$BLOCKED" == false ]] &&
      [[ "$GLOBAL_LINT_OK" == true ]]; then

      case "$file" in
        *.sh|*.md|*)
          check_file "$file" || BLOCKED=true
          ;;
      esac
    fi
  fi

  # ───────────────────────────────────────────────────────────
  # ⏭️ Skip broken file
  # ───────────────────────────────────────────────────────────

  if [[ "$BLOCKED" == true ]]; then
    skip "Skipped — leaving $file uncommitted."
    echo "${MAGENTA}╰──────────────────────────────────────────────${RESET}"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # ───────────────────────────────────────────────────────────
  # 📝 Commit preview
  # ───────────────────────────────────────────────────────────

  MESSAGE="$(commit_message_for_file "$file")"

  echo ""
  echo "${BOLD}Commit${RESET}"
  echo "  ${CYAN}$MESSAGE${RESET}"
  echo ""

  # ───────────────────────────────────────────────────────────
  # 📦 Individual commit
  # ───────────────────────────────────────────────────────────

  if git commit \
    --only \
    --no-verify \
    -m "$MESSAGE" \
    -- "$file"; then

    ok "Committed $file"
    COMMITTED=$((COMMITTED + 1))
  else
    error "Git commit failed for $file"
    SKIPPED=$((SKIPPED + 1))
  fi

  echo "${MAGENTA}╰──────────────────────────────────────────────${RESET}"
done

# ───────────────────────────────────────────────────────────────
# 🎉 Final report
# ───────────────────────────────────────────────────────────────

header "🎉 Starfire Commit Report"

echo ""
echo "  ${GREEN}✅ Committed${RESET}   $COMMITTED"
echo "  ${YELLOW}⏭️  Skipped${RESET}     $SKIPPED"
echo ""

if git diff --quiet && git diff --cached --quiet; then
  echo "${GREEN}${BOLD}✨ Working tree clean.${RESET}"
else
  echo "${YELLOW}${BOLD}📌 Remaining changes:${RESET}"
  echo ""

  git status --short
fi

echo ""

if [[ "$SKIPPED" -eq 0 ]]; then
  echo "${GREEN}${BOLD}🔥 Everything is clean and committed.${RESET}"
else
  echo "${YELLOW}${BOLD}🛠️  Fix the skipped files and run again.${RESET}"
fi

echo ""
echo "${DIM}Finished: $(date '+%H:%M:%S')${RESET}"
echo ""
```

### One important thing

After pasting it, run **exactly**:

```bash
chmod +x scripts/commit-all.sh
bash -n scripts/commit-all.sh
./scripts/commit-all.sh
```

You should now immediately see:

```text
╭────────────────────────────────────────────────╮
│ 🌌 Starfire Smart Commit                       │
╰────────────────────────────────────────────────╯

Repository  /home/thor/Projects/starfire
Branch      main
Started     12:05:31

╭────────────────────────────────────────────────╮
│ 🎨 Format                                     │
╰────────────────────────────────────────────────╯

▶ Biome format
┌─ $ pnpm format
...
```

And the commits can look like:

```text
🚀 feat(voice): smooth out realtime voice
🛡️ fix(electron): harden the desktop agent bridge
📚 docs(docs): refresh the Starfire map
🧪 test(eval): improve agent evaluation
🧹 chore(scripts): level up the developer workflow
✨ feat(ui): make the experience smoother
🔐 fix(tools): lock down tool safety
```

Much less robot, much more **Starfire**. 🌌