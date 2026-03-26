#!/bin/bash
# KiCad Part Finder — clean uninstaller
# Removes all installed components. Does NOT delete your downloaded KiCad libraries.

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "[INFO] $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo ""
echo -e "${BOLD}KiCad Part Finder — Uninstaller${NC}"
echo "============================================"
echo ""

# 1. Stop and remove LaunchAgent (macOS)
if [ "$(uname)" = "Darwin" ]; then
  PLIST="${HOME}/Library/LaunchAgents/com.kicad-part-finder.server.plist"
  if [ -f "$PLIST" ]; then
    info "Stopping server..."
    launchctl bootout gui/$(id -u)/com.kicad-part-finder.server 2>/dev/null || true
    rm -f "$PLIST"
    ok "LaunchAgent removed"
  fi
fi

# 2. Kill any running server
if lsof -ti:3456 &>/dev/null; then
  kill $(lsof -ti:3456) 2>/dev/null || true
  ok "Server process stopped"
fi

# 3. Remove config and startup script
if [ -d "${HOME}/.kicad-part-finder" ]; then
  rm -rf "${HOME}/.kicad-part-finder"
  ok "Config directory removed"
fi

if [ -f "${HOME}/.kicad-part-finder.json" ]; then
  rm -f "${HOME}/.kicad-part-finder.json"
  ok "Server config removed"
fi

# 4. Remove log files
rm -f "${HOME}/Library/Logs/kicad-part-server.log"
rm -f "${HOME}/Library/Logs/kicad-part-server.log.old"
ok "Log files removed"

# 5. KiCad libraries — ask before deleting
echo ""
if [ -d "${HOME}/KiCad/custom-libs" ]; then
  echo -e "${YELLOW}Found downloaded KiCad libraries at ~/KiCad/custom-libs/${NC}"
  echo "These contain the symbols, footprints, and 3D models you installed."
  read -p "Delete these libraries? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "${HOME}/KiCad/custom-libs"
    ok "KiCad libraries removed"
    echo ""
    warn "You may need to manually remove the 'KiCadPartFinder' entry from:"
    warn "  ~/Library/Preferences/kicad/*/sym-lib-table"
    warn "  ~/Library/Preferences/kicad/*/fp-lib-table"
    warn "Or just open KiCad → Manage Libraries and delete the entry."
  else
    info "Keeping KiCad libraries (they'll still work in KiCad)"
  fi
fi

echo ""
echo -e "${BOLD}Uninstall complete.${NC}"
echo ""
echo "Don't forget to remove the extension from Chrome:"
echo "  chrome://extensions → find 'KiCad Part Finder' → Remove"
echo ""
