#!/usr/bin/env bash

set -e

ROOT="$(git rev-parse --show-toplevel)"

EMOJIS=(
  "🚀"
  "⚡"
  "🔥"
  "✨"
  "🛠️"
  "💫"
  "🧠"
  "🎯"
  "🦾"
  "🌟"
  "💎"
  "🔧"
  "🎨"
  "🪄"
  "👾"
  "🤖"
  "🧑‍💻"
  "💻"
  "🐧"
  "🌈"
  "☄️"
  "🌌"
  "🛰️"
  "🛸"
  "👽"
  "😎"
  "🤠"
  "🥷"
  "🗿"
  "👻"
  "💀"
  "☠️"
  "😈"
  "👹"
  "🐉"
  "🐲"
  "🦄"
  "🐺"
  "🦊"
  "🐸"
  "🐼"
  "🐙"
  "🦀"
  "🦈"
  "🐳"
  "🌊"
  "🍀"
  "🌱"
  "🌴"
  "🍄"
  "🍕"
  "🍔"
  "🍜"
  "🍿"
  "🎮"
  "🎲"
  "🎸"
  "🎧"
  "🎵"
  "🏆"
  "🥇"
  "💥"
  "💣"
  "🔮"
  "🧿"
  "🪐"
  "🌙"
  "☀️"
  "❄️"
  "🌪️"
  "💡"
  "🔋"
  "🧪"
  "🧬"
  "📡"
  "🔭"
  "🧩"
  "🌀"
  "🎉"
  "🥳"
  "🤯"
  "🫡"
  "🫠"
  "😏"
  "😼"
)
get_emoji() {
  echo "${EMOJIS[$RANDOM % ${#EMOJIS[@]}]}"
}

get_message() {
  local type="$1"
  local file="$2"
  local emoji
  emoji=$(get_emoji)

  if [[ "$type" == "added" ]]; then
    local messages=(
      "Added: $file $emoji"
      "$file added $emoji"
      "Added $file $emoji"
      "New: $file $emoji"
      "$file created $emoji"
    )
  else
    local messages=(
      "Updated: $file $emoji"
      "$file updated $emoji"
      "Updated $file $emoji"
      "$file changed $emoji"
      "$file improved $emoji"
    )
  fi

  echo "${messages[$RANDOM % ${#messages[@]}]}"
}

cd "$ROOT"

git status --porcelain -z | while IFS= read -r -d '' line; do
  status="${line:0:2}"
  file="${line:3}"

  # Skip deleted files
  if [[ "$status" == " D" || "$status" == "D " ]]; then
    echo "⏭️ Skipping deleted: $file"
    continue
  fi

  # Handle renames
  if [[ "$file" == *" -> "* ]]; then
    file="${file##* -> }"
  fi

  filename=$(basename "$file")

  if [[ "$status" == "??" || "$status" == "A " ]]; then
    message=$(get_message "added" "$filename")
  else
    message=$(get_message "updated" "$filename")
  fi

  echo ""
  echo "📦 $message"

  git add -- "$file"
  git commit -m "$message"

  echo "✅ $message"
done

echo ""
echo "🎉 All files committed!"