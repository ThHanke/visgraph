#!/usr/bin/env bash
# Called at relay session start. Clears session.log and starts a persistent
# aggregator that tails all console-*.log files into it.
LOG_DIR="$(dirname "$0")/../.playwright-mcp"
SESSION_LOG="$LOG_DIR/session.log"

# Kill any previous aggregator
if [ -f "$LOG_DIR/.session-log-pid" ]; then
  old_pid=$(cat "$LOG_DIR/.session-log-pid")
  kill "$old_pid" 2>/dev/null
fi

# Clear log
> "$SESSION_LOG"

# Start aggregator: watch for new console-*.log files and tail them
(
  declare -A tailed
  while true; do
    for f in "$LOG_DIR"/console-*.log; do
      [ -f "$f" ] || continue
      if [ -z "${tailed[$f]+x}" ]; then
        tailed["$f"]=1
        tail -F "$f" -n +1 >> "$SESSION_LOG" &
      fi
    done
    sleep 1
  done
) &
echo $! > "$LOG_DIR/.session-log-pid"
echo "[session-log] started aggregator PID=$(cat $LOG_DIR/.session-log-pid) → $SESSION_LOG"
