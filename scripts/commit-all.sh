
#!/usr/bin/env bash

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)" || {
  echo "❌ Not inside a Git repository."
  exit 1
}

cd "$ROOT" || exit 1

# ═══════════════════════════════════════════════════════════════
# 🌌 STARFIRE SMART COMMIT
#
#   1. Stage everything
#   2. Run the REAL Lefthook pre-commit UI once
#   3. Find files mentioned by failed checks
#   4. Commit clean files one-by-one
#   5. Skip files linked to failures
#
# Individual commits use --no-verify because Lefthook has already
# run once against the complete staged change set.
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
  BLUE=$'\033[34m'
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
  BLUE=""
  MAGENTA=""
  CYAN=""
  WHITE=""
fi

# ───────────────────────────────────────────────────────────────
# 🎲 Commit emoji pools
# ───────────────────────────────────────────────────────────────

FEAT_EMOJIS=("🚀" "✨" "🌌" "⚡" "💫" "🛸" "🌠" "🔥" "🎨" "🪐")
FIX_EMOJIS=("🛡️" "🔐" "🧩" "🔧" "🛠️" "⚙️" "🚧" "🧠" "🔥" "🪄")
TEST_EMOJIS=("🧪" "🔬" "🎯" "🔎" "🧬" "🕵️" "📊" "🧭" "🧫" "🧰")
DOCS_EMOJIS=("📚" "📝" "📖" "🗺️" "✍️" "🪶" "📜" "💡" "🧾" "📰")
CHORE_EMOJIS=("🧹" "🛠️" "⚙️" "🔩" "🧰" "🪛" "🔨" "🧱" "🗂️" "🔧")

declare -A USED_EMOJIS=()

# ───────────────────────────────────────────────────────────────
# 💬 Commit subject pools
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
# 🧰 UI
# ───────────────────────────────────────────────────────────────

header() {
  echo ""
  echo "${CYAN}${BOLD}╭────────────────────────────────────────────────╮${RESET}"
  printf "${CYAN}${BOLD}│ %-46s │${RESET}\n" "$1"
  echo "${CYAN}${BOLD}╰────────────────────────────────────────────────╯${RESET}"
  echo ""
}

ok() {
  echo "${GREEN}✅ $1${RESET}"
}

fail() {
  echo "${RED}❌ $1${RESET}"
}

info() {
  echo "${BLUE}ℹ️  $1${RESET}"
}

skip() {
  echo "${YELLOW}⏭️  $1${RESET}"
}

# ───────────────────────────────────────────────────────────────
# 🎲 Random emoji
# ───────────────────────────────────────────────────────────────

pick_emoji() {
  local type="$1"
  local -a pool
  local -a available
  local emoji
  local index

  case "$type" in
    feat)  pool=("${FEAT_EMOJIS[@]}") ;;
    fix)   pool=("${FIX_EMOJIS[@]}") ;;
    test)  pool=("${TEST_EMOJIS[@]}") ;;
    docs)  pool=("${DOCS_EMOJIS[@]}") ;;
    *)     pool=("${CHORE_EMOJIS[@]}") ;;
  esac

  available=()

  for emoji in "${pool[@]}"; do
    if [[ "${USED_EMOJIS[$emoji]:-0}" -eq 0 ]]; then
      available+=("$emoji")
    fi
  done

  if [[ "${#available[@]}" -eq 0 ]]; then
    for emoji in "${pool[@]}"; do
      unset "USED_EMOJIS[$emoji]"
    done

    available=("${pool[@]}")
  fi

  index=$((RANDOM % ${#available[@]}))
  emoji="${available[$index]}"

  USED_EMOJIS["$emoji"]=1

  printf "%s" "$emoji"
}

random_subject() {
  local type="$1"
  local -a pool
  local index

  case "$type" in
    fix)   pool=("${FIX_SUBJECTS[@]}") ;;
    test)  pool=("${TEST_SUBJECTS[@]}") ;;
    docs)  pool=("${DOCS_SUBJECTS[@]}") ;;
    feat)  pool=("${FEAT_SUBJECTS[@]}") ;;
    *)     pool=("${CHORE_SUBJECTS[@]}") ;;
  esac

  index=$((RANDOM % ${#pool[@]}))

  printf "%s" "${pool[$index]}"
}

# ───────────────────────────────────────────────────────────────
# 📝 Commit message
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

  printf "%s %s(%s): %s" \
    "$(pick_emoji "$type")" \
    "$type" \
    "$scope" \
    "$subject"
}

# ───────────────────────────────────────────────────────────────
# 🔎 Did a failed check mention this file?
# ───────────────────────────────────────────────────────────────

failure_mentions_file() {
  local log="$1"
  local file="$2"

  [[ -s "$log" ]] || return 1

  grep -Fq -- "$file" "$log" ||
    grep -Fq -- "./$file" "$log"
}

# ───────────────────────────────────────────────────────────────
# 🐚 Extra validation for non-code files
# ───────────────────────────────────────────────────────────────

validate_special_file() {
  local file="$1"

  case "$file" in
    *.sh)
      echo "   🐚 bash -n $file"

      if ! bash -n "$file"; then
        fail "Shell syntax failed"
        return 1
      fi

      ok "Shell syntax passed"

      if command -v shellcheck >/dev/null 2>&1; then
        echo "   🔎 shellcheck $file"

        if ! shellcheck "$file"; then
          fail "ShellCheck failed"
          return 1
        fi

        ok "ShellCheck passed"
      fi
      ;;

    *.md)
      echo "   📚 Markdown — no source-code check needed"
      ok "Documentation accepted"
      ;;

    *)
      return 0
      ;;
  esac

  return 0
}

# ═══════════════════════════════════════════════════════════════
# 🚀 START
# ═══════════════════════════════════════════════════════════════

header "🌌 STARFIRE SMART COMMIT"

echo "📍 Repo    : $ROOT"
echo "🌿 Branch  : $(git branch --show-current)"
echo "🕒 Started : $(date '+%H:%M:%S')"

# ───────────────────────────────────────────────────────────────
# 📦 Stage
# ───────────────────────────────────────────────────────────────

header "📦 STAGE"

echo "Adding all changes..."
git add -A

if git diff --cached --quiet; then
  info "Nothing to commit."
  exit 0
fi

mapfile -d '' -t FILES < <(
  git diff --cached --name-only -z
)

FILE_COUNT="${#FILES[@]}"

echo ""
echo "🧠 $FILE_COUNT changed file(s)"
echo ""

for file in "${FILES[@]}"; do
  echo "   • $file"
done

# ───────────────────────────────────────────────────────────────
# 🥊 REAL LEFTHOOK
# ───────────────────────────────────────────────────────────────

header "🥊 LEFTHOOK PRE-COMMIT"

echo "Running the real Lefthook UI once."
echo "Nothing is hidden."
echo ""
echo "Expected checks:"
echo "   🧹 Biome"
echo "   🧠 TypeScript"
echo "   🧪 Tests"
echo ""

HOOK_LOG="$(mktemp)"

# `script` gives Lefthook a real TTY while also capturing output.
# This keeps the normal Lefthook UI visible in the terminal.
if command -v script >/dev/null 2>&1; then
  script -qefc "pnpm exec lefthook run pre-commit" "$HOOK_LOG"
  HOOK_STATUS=$?
else
  warn "util-linux 'script' command not found."
  warn "Running Lefthook directly; failure attribution will be limited."

  pnpm exec lefthook run pre-commit 2>&1 | tee "$HOOK_LOG"
  HOOK_STATUS="${PIPESTATUS[0]}"
fi

echo ""

if [[ "$HOOK_STATUS" -eq 0 ]]; then
  ok "Lefthook passed ✅"
else
  fail "Lefthook found problems."
  echo ""
  echo "The commits will continue."
  echo "Files mentioned by failed checks will be skipped."
fi

# Re-read staged files because Biome may have fixed/staged files.
mapfile -d '' -t FILES < <(
  git diff --cached --name-only -z
)

FILE_COUNT="${#FILES[@]}"

# ───────────────────────────────────────────────────────────────
# 🚀 Individual commits
# ───────────────────────────────────────────────────────────────

header "🚀 INDIVIDUAL COMMITS"

COMMITTED=0
SKIPPED=0
INDEX=0

for file in "${FILES[@]}"; do
  INDEX=$((INDEX + 1))

  echo ""
  echo "${MAGENTA}${BOLD}╭─ [$INDEX/$FILE_COUNT] $file${RESET}"
  echo "${MAGENTA}╰────────────────────────────────────────────────${RESET}"

  BLOCKED=false

  # If Lefthook failed and explicitly mentioned this file,
  # this changed file is considered broken.
  if [[ "$HOOK_STATUS" -ne 0 ]] &&
    failure_mentions_file "$HOOK_LOG" "$file"; then

    fail "Lefthook reported a problem in this file."
    BLOCKED=true
  fi

  # Extra check for shell scripts because Biome does not check them.
  if [[ "$BLOCKED" == false ]]; then
    if ! validate_special_file "$file"; then
      BLOCKED=true
    fi
  fi

  if [[ "$BLOCKED" == true ]]; then
    skip "Not committing → $file"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  MESSAGE="$(commit_message_for_file "$file")"

  echo ""
  echo "   📝 $MESSAGE"
  echo "   📦 committing only this file..."

  # Lefthook already ran once above.
  # Do not execute it again for every file.
  if git commit \
    --only \
    --no-verify \
    -m "$MESSAGE" \
    -- "$file"; then

    ok "Committed → $file"
    COMMITTED=$((COMMITTED + 1))
  else
    fail "Commit failed → $file"
    SKIPPED=$((SKIPPED + 1))
  fi
done

rm -f "$HOOK_LOG"

# ───────────────────────────────────────────────────────────────
# 🎉 Report
# ───────────────────────────────────────────────────────────────

header "🎉 STARFIRE COMMIT REPORT"

echo "   ✅ Committed : $COMMITTED"
echo "   ⏭️  Skipped   : $SKIPPED"
echo ""

if git diff --quiet && git diff --cached --quiet; then
  echo "${GREEN}${BOLD}✨ Working tree clean.${RESET}"
else
  echo "${YELLOW}${BOLD}📌 Remaining changes:${RESET}"
  echo ""

  git status --short
fi

echo ""

if [[ "$HOOK_STATUS" -eq 0 && "$SKIPPED" -eq 0 ]]; then
  echo "${GREEN}${BOLD}🔥 Everything passed and every file was committed.${RESET}"
elif [[ "$COMMITTED" -gt 0 ]]; then
  echo "${YELLOW}${BOLD}🛠️  Good files were committed; problem files were left behind.${RESET}"
else
  echo "${RED}${BOLD}❌ Nothing was committed.${RESET}"
fi

echo ""
echo "🕒 Finished : $(date '+%H:%M:%S')"
echo