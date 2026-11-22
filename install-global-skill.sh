#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Antigravity Global Skills Directory
mkdir -p "$HOME/.gemini/config/skills"
ln -sfn "$SKILL_DIR" "$HOME/.gemini/config/skills/agentic-guardrails"
echo "✅ Linked global Antigravity skill -> ~/.gemini/config/skills/agentic-guardrails"

# 2. Claude Code Global Skills Directory
mkdir -p "$HOME/.claude/skills"
ln -sfn "$SKILL_DIR" "$HOME/.claude/skills/agentic-guardrails"
echo "✅ Linked global Claude Code skill -> ~/.claude/skills/agentic-guardrails"

# 3. GitHub Copilot CLI Global Skills Directory
mkdir -p "$HOME/.copilot/skills"
ln -sfn "$SKILL_DIR" "$HOME/.copilot/skills/agentic-guardrails"
echo "✅ Linked global Copilot skill -> ~/.copilot/skills/agentic-guardrails"

echo ""
echo "Done! In Claude Code, GitHub Copilot, or Antigravity, you can now invoke 'agentic-guardrails'."
