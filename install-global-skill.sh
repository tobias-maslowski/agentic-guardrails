#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

link_skill() {
  local label="$1" parent="$2"
  local dest="$parent/agentic-guardrails"
  mkdir -p "$parent"
  # `ln -sfn` onto a real directory would nest the link inside it (BSD/macOS) or fail (GNU); refuse explicitly.
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "❌ $dest already exists and is not a symlink. Move it away and re-run." >&2
    return 1
  fi
  ln -sfn "$SKILL_DIR" "$dest"
  if [ "$(cd "$dest" && pwd -P)" != "$SKILL_DIR" ]; then
    echo "❌ $dest does not point at $SKILL_DIR" >&2
    return 1
  fi
  echo "✅ Linked global $label skill -> $dest"
}

status=0
link_skill "Antigravity" "$HOME/.gemini/config/skills" || status=1
link_skill "Claude Code" "$HOME/.claude/skills" || status=1
link_skill "GitHub Copilot CLI" "$HOME/.copilot/skills" || status=1

echo ""
if [ "$status" -eq 0 ]; then
  echo "Done! In Claude Code, GitHub Copilot, or Antigravity, you can now invoke 'agentic-guardrails'."
else
  echo "Finished with errors (see above)." >&2
fi
exit "$status"
