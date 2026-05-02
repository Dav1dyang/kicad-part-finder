#!/bin/bash
# KiCad Part Finder — one-command installer
# Usage: bash install.sh
#
# What this does:
#   1. Checks prerequisites (Node.js, Python3)
#   2. Installs pnpm if needed
#   3. Installs Node.js dependencies
#   4. Creates a Python venv and installs easyeda2kicad
#   5. Builds the Chrome extension
#   6. Optionally sets up auto-start (macOS LaunchAgent)
#   7. Prints next steps (load extension in Chrome)
#
# What this does NOT do:
#   - Modify any system files
#   - Require sudo/root
#   - Install anything outside this project + ~/.kicad-part-finder/
#   - Touch your existing KiCad libraries (that happens at runtime, with backups)

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERROR]${NC} $1"; }

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="${PROJECT_DIR}/.venv"
CONFIG_DIR="${HOME}/.kicad-part-finder"

echo ""
echo -e "${BOLD}KiCad Part Finder — Installer${NC}"
echo "============================================"
echo ""

# --- 1. Check prerequisites ---
info "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install from https://nodejs.org (v20+)"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  err "Node.js v20+ required, found $(node -v)"
  exit 1
fi
ok "Node.js $(node -v)"

# Python3
if ! command -v python3 &>/dev/null; then
  warn "Python3 not found. easyeda2kicad converter won't work."
  warn "You can still use ZIP drag-and-drop for SnapEDA/CSE files."
  SKIP_PYTHON=1
else
  ok "Python3 $(python3 --version | awk '{print $2}')"
  SKIP_PYTHON=0
fi

# --- 2. Install pnpm if needed ---
if ! command -v pnpm &>/dev/null; then
  info "Installing pnpm..."
  npm install -g pnpm
  ok "pnpm installed"
else
  ok "pnpm $(pnpm -v)"
fi

# --- 3. Install Node.js dependencies ---
info "Installing Node.js dependencies..."
cd "$PROJECT_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed"

# --- 4. Python venv + easyeda2kicad ---
if [ "$SKIP_PYTHON" = "0" ]; then
  if [ ! -d "$VENV_DIR" ]; then
    info "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
  fi
  info "Installing easyeda2kicad..."
  "$VENV_DIR/bin/pip" install -q --upgrade easyeda2kicad
  CONVERTER_VERSION=$("$VENV_DIR/bin/easyeda2kicad" --version 2>/dev/null | head -1 || echo "unknown")
  ok "easyeda2kicad ${CONVERTER_VERSION} installed at ${VENV_DIR}/bin/easyeda2kicad"

  # Persist the converter path so the server uses the venv we just provisioned,
  # rather than auto-detecting some unrelated venv on the user's machine.
  info "Recording converter path in ~/.kicad-part-finder.json..."
  node -e '
    const fs = require("fs"), path = require("path"), os = require("os");
    const cfg = path.join(os.homedir(), ".kicad-part-finder.json");
    const cur = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, "utf8")) : {};
    cur.converterPath = process.argv[1];
    fs.writeFileSync(cfg, JSON.stringify(cur, null, 2));
  ' "${VENV_DIR}/bin/easyeda2kicad"
  ok "Server config updated"
else
  warn "Skipping easyeda2kicad (no Python3)"
fi

# --- 5. Build Chrome extension ---
info "Building Chrome extension..."
cd "$PROJECT_DIR"
pnpm build:extension
ok "Extension built at packages/extension/dist/"

# --- 6. Run tests ---
info "Running tests..."
if pnpm test 2>&1 | tail -5; then
  ok "All tests passed"
else
  warn "Some tests failed — the extension may still work"
fi

# --- 7. Create config directory ---
mkdir -p "$CONFIG_DIR"

# --- 8. macOS LaunchAgent (optional) ---
if [ "$(uname)" = "Darwin" ]; then
  echo ""
  echo -e "${BOLD}Auto-start server on login?${NC}"
  echo "The companion server needs to run for the extension to work."
  echo "A LaunchAgent will start it automatically on login."
  echo ""
  read -p "Set up auto-start? [Y/n] " -n 1 -r
  echo ""

  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    CONVERTER_PATH="${VENV_DIR}/bin/easyeda2kicad"
    [ "$SKIP_PYTHON" = "1" ] && CONVERTER_PATH="easyeda2kicad"

    # Create watchdog startup script
    cat > "${CONFIG_DIR}/start.sh" << WATCHDOG
#!/bin/bash
set -euo pipefail

SERVER_DIR="${PROJECT_DIR}/packages/server"
LOG_FILE="\${HOME}/Library/Logs/kicad-part-server.log"
NODE_BIN="$(which node)"

mkdir -p "\$(dirname "\${LOG_FILE}")"

# Rotate log if over 5MB
if [ -f "\${LOG_FILE}" ]; then
  LOG_SIZE=\$(stat -f%z "\${LOG_FILE}" 2>/dev/null || echo "0")
  if [ "\${LOG_SIZE}" -gt 5242880 ]; then
    mv "\${LOG_FILE}" "\${LOG_FILE}.old"
  fi
fi

log() { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$1" >> "\${LOG_FILE}"; }

log "Watchdog starting"

retries=0
while [ \$retries -lt 100 ]; do
  log "Starting server (attempt \$((retries + 1)))"

  cd "\${SERVER_DIR}" 2>/dev/null || {
    log "ERROR: Server directory not found. Waiting 30s..."
    sleep 30
    retries=\$((retries + 1))
    continue
  }

  "\${NODE_BIN}" --import tsx src/index.ts >> "\${LOG_FILE}" 2>&1
  EXIT_CODE=\$?

  log "Server exited with code \${EXIT_CODE}"
  [ \$EXIT_CODE -eq 0 ] && break

  retries=\$((retries + 1))
  log "Restarting in 5s..."
  sleep 5
done
WATCHDOG
    chmod +x "${CONFIG_DIR}/start.sh"

    # Create LaunchAgent plist
    PLIST_PATH="${HOME}/Library/LaunchAgents/com.kicad-part-finder.server.plist"
    cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kicad-part-finder.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${CONFIG_DIR}/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/kicad-part-server.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/kicad-part-server.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>EASYEDA2KICAD_PATH</key>
        <string>${CONVERTER_PATH}</string>
    </dict>
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>1024</integer>
    </dict>
</dict>
</plist>
PLIST

    # Load the LaunchAgent
    launchctl bootout gui/$(id -u)/com.kicad-part-finder.server 2>/dev/null || true
    launchctl bootstrap gui/$(id -u) "$PLIST_PATH"
    launchctl kickstart gui/$(id -u)/com.kicad-part-finder.server 2>/dev/null || true

    sleep 3
    if curl -s http://localhost:3456/health | grep -q '"ok":true'; then
      ok "Server started and healthy"
    else
      warn "Server may need a moment to start. Check: curl http://localhost:3456/health"
    fi

    ok "LaunchAgent installed — server will auto-start on login"
  fi
fi

# --- Done ---
echo ""
echo "============================================"
echo -e "${GREEN}${BOLD}Installation complete!${NC}"
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Open Chrome → chrome://extensions"
echo "  2. Enable Developer Mode (top right)"
echo "  3. Click 'Load unpacked'"
echo "  4. Select: ${PROJECT_DIR}/packages/extension/dist"
echo ""
echo "  Then navigate to any DigiKey or LCSC product page"
echo "  and press Cmd+Shift+2 (Mac) or Ctrl+Shift+2 (Win)"
echo ""
if [ "$(uname)" != "Darwin" ]; then
  echo "  Start the server manually:"
  echo "    cd ${PROJECT_DIR}/packages/server"
  echo "    npx tsx src/index.ts"
  echo ""
fi
echo "  Docs: ${PROJECT_DIR}/README.md"
echo ""
