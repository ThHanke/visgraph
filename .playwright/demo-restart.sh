#!/usr/bin/env bash
# demo-restart.sh — Clean restart for OWUI relay demo session.
#
# Run this from the terminal BEFORE asking Claude to run pizza-demo-setup.js.
# Kills stale playwright-mcp + Chrome instances and removes Chrome lock files
# so the MCP browser tools start fresh on the next call.
#
# Usage:  bash .playwright/demo-restart.sh

set -e

echo "Killing playwright-mcp processes..."
pkill -f "playwright-mcp" 2>/dev/null || true
pkill -f "mcp-chrome-for-testing" 2>/dev/null || true
sleep 2

echo "Removing Chrome lock files..."
PROFILE_DIR="$HOME/.cache/ms-playwright/mcp-chrome-for-testing-5c936c5"
rm -f "$PROFILE_DIR/SingletonLock" \
      "$PROFILE_DIR/SingletonSocket" \
      "$PROFILE_DIR/SingletonCookie" 2>/dev/null || true

echo "Done. MCP browser will start fresh on next tool call."
echo "Now ask Claude to run: mcp__playwright__browser_run_code_unsafe filename=.playwright/pizza-demo-setup.js"
