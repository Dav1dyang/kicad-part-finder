#!/bin/bash
# KiCad Part Server — startup script for LaunchAgent
# This script is called by macOS on login to start the companion server.

set -euo pipefail

# Paths
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node 2>/dev/null || echo "/usr/local/bin/node")"
TSX_BIN="${SERVER_DIR}/node_modules/.bin/tsx"
LOG_DIR="${HOME}/Library/Logs"
LOG_FILE="${LOG_DIR}/kicad-part-server.log"
PID_FILE="${HOME}/.kicad-part-server.pid"

# Ensure log directory exists
mkdir -p "${LOG_DIR}"

# Check Node.js is available
if [ ! -x "${NODE_BIN}" ]; then
  echo "[$(date)] ERROR: Node.js not found at ${NODE_BIN}" >> "${LOG_FILE}"
  exit 1
fi

# Check tsx is available
if [ ! -x "${TSX_BIN}" ]; then
  echo "[$(date)] ERROR: tsx not found at ${TSX_BIN}" >> "${LOG_FILE}"
  echo "[$(date)] Run: cd ${SERVER_DIR} && pnpm install" >> "${LOG_FILE}"
  exit 1
fi

# Kill any existing instance
if [ -f "${PID_FILE}" ]; then
  OLD_PID=$(cat "${PID_FILE}" 2>/dev/null || echo "")
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "[$(date)] Stopping existing server (PID ${OLD_PID})" >> "${LOG_FILE}"
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 1
  fi
  rm -f "${PID_FILE}"
fi

# Rotate log if over 5MB
if [ -f "${LOG_FILE}" ]; then
  LOG_SIZE=$(stat -f%z "${LOG_FILE}" 2>/dev/null || echo "0")
  if [ "${LOG_SIZE}" -gt 5242880 ]; then
    mv "${LOG_FILE}" "${LOG_FILE}.old"
  fi
fi

echo "[$(date)] Starting KiCad Part Server" >> "${LOG_FILE}"
echo "[$(date)] Server dir: ${SERVER_DIR}" >> "${LOG_FILE}"
echo "[$(date)] Node: ${NODE_BIN}" >> "${LOG_FILE}"

# Start the server
cd "${SERVER_DIR}"
exec "${TSX_BIN}" src/index.ts >> "${LOG_FILE}" 2>&1
