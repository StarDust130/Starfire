```bash
#!/usr/bin/env bash

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# ═══════════════════════════════════════════════════════════════
# 🔥 Starfire Smart Commit
#
# Flow:
#   1. Format once
#   2. Stage everything
#   3. Run global checks once
#   4. Check each file with the right checker
#   5. Commit good files individually
#   6. Skip bad files
#   7. Never run Lefthook repeatedly
#
# Commit emojis:
#   - Randomized per commit
#   - Category-aware
#   - Avoids repeating the same emoji until the pool is used
# ═══════════════════════════════════════════════════════════════

# ───────────────────────────────────────────────────────────────
# 🎨 Colors
# ───────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  RESET=$'\033[0m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'

  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
  MAGENTA=$'\033[35m'
  WHITE=$'\033[37m'
else
  RESET=""
  BOLD=""
  DIM=""

  RED=""
  GREEN=""
  YELLOW=""
  CYAN=""
  MAGENTA=""
  WHITE=""
fi

# ───────────────────────────────────────────────────────────────
# 🎲 Emoji pools
# ───────────────────────────────────────────────────────────────

declare -A USED_EMOJIS=()

FEAT_EMOJIS=(
  "🚀"
  "✨"
  "🌠"
  "🎨"
  "🪐"
  "⚡"
  "🛸"
  "🌌"
  "💫"
  "🔥"
)

FIX_EMOJIS=(
  "🔥"
  "🛡️"
  "⚡"
  "🔐"
  "🧠"
  "🛠️"
  "🚧"
  "🧩"
  "🪄"
  "🔧"
)

TEST_EMOJIS=(
  "🧪"
  "🔬"
  "🧬"
  "🎯"
  "🔎"
  "🕵️"
  "📊"
  "🧫"
  "🧭"
  "🧰"
)

DOCS_EMOJIS=(
  "📚"
  "📝"
  "📖"
  "🗺️"
  "🧾"
  "✍️"
  "🪶"
  "📰"
  "📜"
  "💡"
)

CHORE_EMOJIS=(
  "🛠️"
  "⚙️"
  "🔧"
  "🧹"
  "🧰"
  "🔩"
  "🧱"
  "🪛"
  "🗂️"
  "🔨"
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

success() {
  echo "${GREEN}✅ $1${RESET}"
}

warning() {
  echo "${YELLOW}⚠️  $1${RESET}"
}

error() {
  echo "${RED}❌ $1${RESET}"
}

skip() {
  echo "${YELLOW}⏭️  $1${RESET}"
}

info() {
  echo "${CYAN}ℹ️  $1${RESET}"
}

# ───────────────────────────────────────────────────────────────
# 🎲 Pick a random non-repeating emoji
# ───────────────────────────────────────────────────────────────

pick_emoji() {
  local category="$1"

  local -a pool
  local pool_size
  local available=()
  local emoji
  local index

  case "$category" in
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
    chore)
      pool=("${CHORE_EMOJIS[@]}")
      ;;
    *)
      pool=("${CHORE_EMOJIS[@]}")
      ;;
  esac

  pool_size="${#pool[@]}"

  # Find emojis not used during this script run.
  for emoji in "${pool[@]}"; do
    if [[ "${USED_EMOJIS[$emoji]:-0}" -eq 0 ]]; then
      available+=("$emoji")
    fi
  done

  # If the whole category was used, reset that category.
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
# 📝 Commit message generator
# ───────────────────────────────────────────────────────────────

commit_message_for_file() {
  local file="$1"

  local type="chore"
  local scope="project"
  local subject="update Starfire"
  local emoji=""

  # ───────────────────────────────────────────────────────────
  # Determine type / scope / subject
  # ───────────────────────────────────────────────────────────

  case "$file" in
    eval/*)
      type="test"
      scope="eval"
      subject="improve agent evaluation"
      ;;

    *.test.*|*.spec.*|*/test/*|*/tests/*)
      type="test"
      scope="tests"
      subject="improve test coverage"
      ;;

    docs/*|*.md)
      type="docs"
      scope="docs"
      subject="update documentation"
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
          subject="strengthen tool safety"
          ;;
        */validate.ts)
          subject="strengthen tool validation"
          ;;
        *)
          subject="improve tool behavior"
          ;;
      esac
      ;;

    apps/core/*)
      type="fix"
      scope="core"

      case "$file" in
        */agent-runner.ts)
          subject="strengthen agent execution"
          ;;
        *)
          subject="improve agent core"
          ;;
      esac
      ;;

    apps/desktop/electron/*)
      type="fix"
      scope="electron"

      case "$file" in
        */realtimeVoice.ts)
          subject="strengthen realtime voice"
          ;;
        */agent/*)
          subject="strengthen desktop agent bridge"
          ;;
        *)
          subject="improve desktop integration"
          ;;
      esac
      ;;

    apps/desktop/src/voice/*)
      type="feat"
      scope="voice"
      subject="improve realtime voice"
      ;;

    apps/desktop/src/three/*)
      type="feat"
      scope="ui"
      subject="improve companion experience"
      ;;

    apps/desktop/*)
      type="feat"
      scope="desktop"
      subject="improve desktop experience"
      ;;

    scripts/*)
      type="chore"
      scope="scripts"
      subject="improve developer workflow"
      ;;

    package.json|pnpm-lock.yaml|biome.json|biome.jsonc|lefthook.yml)
      type="chore"
      scope="project"
      subject="update project configuration"
      ;;
  esac

  emoji="$(pick_emoji "$type")"

  printf "%s %s(%s): %s" \
    "$emoji" \
    "$type" \
    "$scope" \
    "$subject"
}

# ───────────────────────────────────────────────────────────────
# 🔎 Check whether a log mentions a file
# ───────────────────────────────────────────────────────────────

log_mentions_file() {
  local log="$1"
  local file="$2"

  [[ -s "$log" ]] || return 1

  grep -Fq -- "$file" "$log" ||
    grep -Fq -- "./$file" "$log"
}

# ───────────────────────────────────────────────────────────────
# 🔍 File-specific validation
# ───────────────────────────────────────────────────────────────

check_file() {
  local file="$1"

  case "$file" in
    # ─────────────────────────────────────────────────────────
    # TypeScript / JavaScript / JSON / CSS
    # ─────────────────────────────────────────────────────────

    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.css)
      echo "${DIM}🔎 Biome check...${RESET}"

      if pnpm exec biome check "$file"; then
        success "Biome passed"
        return 0
      fi

      error "Biome found an issue"
      return 1
      ;;

    # ─────────────────────────────────────────────────────────
    # Bash
    # ─────────────────────────────────────────────────────────

    *.sh)
      echo "${DIM}🐚 Bash syntax check...${RESET}"

      if ! bash -n "$file"; then
        error "Bash syntax check failed"
        return 1
      fi

      success "Bash syntax passed"

      if command -v shellcheck >/dev/null 2>&1; then
        echo "${DIM}🔎 ShellCheck...${RESET}"

        if ! shellcheck "$file"; then
          error "ShellCheck found an issue"
          return 1
        fi

        success "ShellCheck passed"
      else
        info "ShellCheck not installed; using bash -n only."
      fi
      ;;

    # ─────────────────────────────────────────────────────────
    # Markdown
    # ─────────────────────────────────────────────────────────

    *.md)
      echo "${DIM}📚 Markdown file${RESET}"
      success "Documentation accepted"
      ;;

    # ─────────────────────────────────────────────────────────
    # Everything else
    # ─────────────────────────────────────────────────────────

    *)
      echo "${DIM}📦 No file-specific checker${RESET}"
      success "Using global checks"
      ;;
  esac

  return 0
}

# ───────────────────────────────────────────────────────────────
# 🎨 1. FORMAT
# ───────────────────────────────────────────────────────────────

header "🎨 Format Starfire"

if ! pnpm format; then
  error "Formatting failed."
  echo "Nothing will be committed."
  exit 1
fi

success "Formatting complete"

# ───────────────────────────────────────────────────────────────
# 📦 2. STAGE
# ───────────────────────────────────────────────────────────────

header "📦 Stage changes"

git add -A

if git diff --cached --quiet; then
  info "Nothing to commit."
  exit 0
fi

# NUL-separated paths safely handle spaces and special characters.
mapfile -d '' -t FILES < <(
  git diff --cached --name-only -z
)

FILE_COUNT="${#FILES[@]}"

echo "${BOLD}🧠 Changed files: ${WHITE}${FILE_COUNT}${RESET}"
echo ""

for file in "${FILES[@]}"; do
  echo "  • $file"
done

# ───────────────────────────────────────────────────────────────
# 🧪 3. GLOBAL CHECKS — ONLY ONCE
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
echo "${BOLD}🔎 Git diff check${RESET}"

if git diff --cached --check >"$DIFF_LOG" 2>&1; then
  success "Git diff passed"
else
  GLOBAL_DIFF_OK=false
  error "Git diff failed"
  cat "$DIFF_LOG"
fi

# Lint
echo ""
echo "${BOLD}🧹 Biome lint${RESET}"

if pnpm lint >"$LINT_LOG" 2>&1; then
  GLOBAL_LINT_OK=true
  success "Lint passed"
else
  GLOBAL_LINT_OK=false
  error "Lint failed"
  cat "$LINT_LOG"
fi

# Typecheck
echo ""
echo "${BOLD}🧠 Typecheck${RESET}"

if pnpm typecheck >"$TYPECHECK_LOG" 2>&1; then
  GLOBAL_TYPECHECK_OK=true
  success "Typecheck passed"
else
  GLOBAL_TYPECHECK_OK=false
  error "Typecheck failed"
  cat "$TYPECHECK_LOG"
fi

# Tests
echo ""
echo "${BOLD}🧪 Tests${RESET}"

if pnpm test >"$TEST_LOG" 2>&1; then
  GLOBAL_TEST_OK=true
  success "Tests passed"
else
  GLOBAL_TEST_OK=false
  error "Tests failed"
  cat "$TEST_LOG"
fi

# ───────────────────────────────────────────────────────────────
# 📊 Global summary
# ───────────────────────────────────────────────────────────────

echo ""
echo "${BOLD}Global result${RESET}"
echo ""

if [[ "$GLOBAL_DIFF_OK" == true ]]; then
  echo "  ${GREEN}✅${RESET} Git diff"
else
  echo "  ${RED}❌${RESET} Git diff"
fi

if [[ "$GLOBAL_LINT_OK" == true ]]; then
  echo "  ${GREEN}✅${RESET} Lint"
else
  echo "  ${RED}❌${RESET} Lint"
fi

if [[ "$GLOBAL_TYPECHECK_OK" == true ]]; then
  echo "  ${GREEN}✅${RESET} Typecheck"
else
  echo "  ${RED}❌${RESET} Typecheck"
fi

if [[ "$GLOBAL_TEST_OK" == true ]]; then
  echo "  ${GREEN}✅${RESET} Tests"
else
  echo "  ${RED}❌${RESET} Tests"
fi

# ───────────────────────────────────────────────────────────────
# 🚀 4. INDIVIDUAL VALIDATION + COMMITS
# ───────────────────────────────────────────────────────────────

header "🚀 Validate & commit individually"

COMMITTED=0
SKIPPED=0
INDEX=0

for file in "${FILES[@]}"; do
  INDEX=$((INDEX + 1))

  echo ""
  echo "${MAGENTA}${BOLD}[$INDEX/$FILE_COUNT] 📄 $file${RESET}"

  STATUS="$(
    git diff --cached --name-status -- "$file" |
      awk 'NR == 1 { print $1 }'
  )"

  # ─────────────────────────────────────────────────────────
  # Deleted files
  # ─────────────────────────────────────────────────────────

  if [[ "$STATUS" == "D" ]]; then
    info "Deleted file — validation skipped."

  else
    FILE_BLOCKED=false

    # Git diff
    if [[ "$GLOBAL_DIFF_OK" == false ]] &&
      log_mentions_file "$DIFF_LOG" "$file"; then
      error "Git diff points to this file."
      FILE_BLOCKED=true
    fi

    # Lint
    if [[ "$GLOBAL_LINT_OK" == false ]] &&
      log_mentions_file "$LINT_LOG" "$file"; then
      error "Lint points to this file."
      FILE_BLOCKED=true
    fi

    # Typecheck
    if [[ "$GLOBAL_TYPECHECK_OK" == false ]] &&
      log_mentions_file "$TYPECHECK_LOG" "$file"; then
      error "Typecheck points to this file."
      FILE_BLOCKED=true
    fi

    # Tests
    if [[ "$GLOBAL_TEST_OK" == false ]] &&
      log_mentions_file "$TEST_LOG" "$file"; then
      error "Tests point to this file."
      FILE_BLOCKED=true
    fi

    if [[ "$FILE_BLOCKED" == true ]]; then
      skip "Skipped: $file"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    # File-specific validation.
    if ! check_file "$file"; then
      skip "Skipped: $file"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
  fi

  # ─────────────────────────────────────────────────────────
  # 📦 Commit exactly this file
  # ─────────────────────────────────────────────────────────

  MESSAGE="$(commit_message_for_file "$file")"

  echo ""
  echo "${CYAN}📝 $MESSAGE${RESET}"

  if git commit \
    --only \
    --no-verify \
    -m "$MESSAGE" \
    -- "$file"; then

    success "Committed: $file"
    COMMITTED=$((COMMITTED + 1))
  else
    error "Git commit failed: $file"
    SKIPPED=$((SKIPPED + 1))
  fi
done

# ───────────────────────────────────────────────────────────────
# 📊 5. FINAL SUMMARY
# ───────────────────────────────────────────────────────────────

header "📊 Commit summary"

echo "  ${GREEN}${BOLD}✅ Committed${RESET} : $COMMITTED"
echo "  ${YELLOW}${BOLD}⏭️  Skipped${RESET}   : $SKIPPED"
echo ""

if git diff --quiet && git diff --cached --quiet; then
  echo "${GREEN}${BOLD}✨ Working tree clean.${RESET}"
else
  echo "${YELLOW}${BOLD}📌 Remaining changes:${RESET}"
  echo ""

  git status --short

  echo ""
  info "Skipped files remain uncommitted."
fi

echo ""

if [[ "$SKIPPED" -eq 0 ]]; then
  echo "${GREEN}${BOLD}🔥 All changed files committed successfully.${RESET}"
else
  echo "${YELLOW}${BOLD}⚠️  Some files were skipped.${RESET}"
  echo "${DIM}Fix them and run ./commit-all.sh again.${RESET}"
fi

echo ""
```

Now your history can look like:

```text
🚀 feat(voice): improve realtime voice
📚 docs(docs): update documentation
🧠 fix(core): strengthen agent execution
🛡️ fix(electron): strengthen realtime voice
🧪 test(tests): improve test coverage
✨ feat(ui): improve companion experience
🔐 fix(tools): strengthen tool safety
⚡ fix(electron): improve desktop integration
```

So every commit gets a **fresh, category-appropriate emoji**, rather than `🔥` on everything. 😎