#!/usr/bin/env bash

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# ─────────────────────────────────────────────
# 🎨 1. Format
# ─────────────────────────────────────────────

echo ""
echo "🎨 Formatting Starfire..."
pnpm format

echo "✅ Formatting complete"

# ─────────────────────────────────────────────
# 📦 2. Stage everything
# ─────────────────────────────────────────────

echo ""
echo "📦 Staging changes..."

git add -A

# ─────────────────────────────────────────────
# 💤 3. Nothing changed?
# ─────────────────────────────────────────────

if git diff --cached --quiet; then
  echo ""
  echo "😴 Nothing to commit."
  exit 0
fi

# ─────────────────────────────────────────────
# 🔍 4. Collect changed files
# ─────────────────────────────────────────────

FILES="$(git diff --cached --name-only)"

FILE_COUNT="$(printf '%s\n' "$FILES" | sed '/^$/d' | wc -l | tr -d ' ')"

echo ""
echo "🧠 Changed files: $FILE_COUNT"
echo ""

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  echo "   • $file"
done <<< "$FILES"

# ─────────────────────────────────────────────
# 📊 5. Detect change area
# ─────────────────────────────────────────────

scope="project"

if printf '%s\n' "$FILES" | grep -q '^packages/tools/'; then
  scope="tools"
elif printf '%s\n' "$FILES" | grep -q '^packages/contracts/'; then
  scope="contracts"
elif printf '%s\n' "$FILES" | grep -q '^apps/core/'; then
  scope="core"
elif printf '%s\n' "$FILES" | grep -q '^apps/desktop/electron/'; then
  scope="electron"
elif printf '%s\n' "$FILES" | grep -q '^apps/desktop/src/voice/'; then
  scope="voice"
elif printf '%s\n' "$FILES" | grep -q '^apps/desktop/src/three/'; then
  scope="ui"
elif printf '%s\n' "$FILES" | grep -q '^apps/desktop/'; then
  scope="desktop"
elif printf '%s\n' "$FILES" | grep -q '^eval/'; then
  scope="eval"
elif printf '%s\n' "$FILES" | grep -q '^docs/'; then
  scope="docs"
fi

# ─────────────────────────────────────────────
# 🧭 6. Detect commit type
# ─────────────────────────────────────────────

TYPE="chore"

if printf '%s\n' "$FILES" | grep -Eq '(^|/)(test|tests)/|\.test\.|\.spec\.'; then
  TYPE="test"
elif printf '%s\n' "$FILES" | grep -q '^docs/'; then
  TYPE="docs"
elif printf '%s\n' "$FILES" | grep -q '^eval/'; then
  TYPE="test"
elif printf '%s\n' "$FILES" | grep -q '^packages/tools/'; then
  TYPE="fix"
elif printf '%s\n' "$FILES" | grep -q '^packages/contracts/'; then
  TYPE="fix"
elif printf '%s\n' "$FILES" | grep -q '^apps/'; then
  TYPE="feat"
fi

# ─────────────────────────────────────────────
# 🧠 7. Pick emoji + message
# ─────────────────────────────────────────────

case "$TYPE" in
  feat)
    EMOJI="🚀"
    VERB="build"
    ;;

  fix)
    EMOJI="🔥"
    VERB="fix"
    ;;

  test)
    EMOJI="🧪"
    VERB="improve"
    ;;

  docs)
    EMOJI="📚"
    VERB="update"
    ;;

  *)
    EMOJI="🛠️"
    VERB="update"
    ;;
esac

# More specific messages for important Starfire areas.
SUBJECT=""

if printf '%s\n' "$FILES" | grep -q 'policy.ts\|registry.ts\|agent.ts'; then
  SUBJECT="strengthen tool safety"
  EMOJI="🔐"
  TYPE="fix"
  scope="tools"
elif printf '%s\n' "$FILES" | grep -q '^eval/'; then
  SUBJECT="improve agent evaluation"
  EMOJI="🧪"
  TYPE="test"
  scope="eval"
elif printf '%s\n' "$FILES" | grep -q '^apps/desktop/src/voice/'; then
  SUBJECT="improve realtime voice"
  EMOJI="🎙️"
  TYPE="feat"
  scope="voice"
elif printf '%s\n' "$FILES" | grep -q '^apps/desktop/src/three/'; then
  SUBJECT="improve companion experience"
  EMOJI="🎨"
  TYPE="feat"
  scope="ui"
elif printf '%s\n' "$FILES" | grep -q '^docs/'; then
  SUBJECT="update architecture docs"
  EMOJI="📚"
  TYPE="docs"
  scope="docs"
elif [[ "$TYPE" == "feat" ]]; then
  SUBJECT="expand Starfire"
elif [[ "$TYPE" == "fix" ]]; then
  SUBJECT="improve Starfire"
elif [[ "$TYPE" == "test" ]]; then
  SUBJECT="improve tests"
else
  SUBJECT="update Starfire"
fi

COMMIT_TITLE="${EMOJI} ${TYPE}(${scope}): ${SUBJECT}"

# ─────────────────────────────────────────────
# 📋 8. Show commit preview
# ─────────────────────────────────────────────

echo ""
echo "╭──────────────────────────────────────────────╮"
echo "│ 🔥 Starfire Commit                          │"
echo "╰──────────────────────────────────────────────╯"
echo ""
echo "  📝 $COMMIT_TITLE"
echo ""
echo "  📦 Files: $FILE_COUNT"
echo ""

# Show stats
git diff --cached --stat

echo ""
echo "🧪 Pre-commit checks will run once..."
echo ""

# ─────────────────────────────────────────────
# 🚀 9. ONE commit
# ─────────────────────────────────────────────

git commit -m "$COMMIT_TITLE"

echo ""
echo "╭──────────────────────────────────────────────╮"
echo "│ ✅ Starfire committed successfully           │"
echo "╰──────────────────────────────────────────────╯"
echo ""
echo "🔥 $COMMIT_TITLE"
echo ""