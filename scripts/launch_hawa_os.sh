#!/usr/bin/env bash
# ==============================================================================
# HAWA CREATIVE OS — TURNKEY ONE-CLICK OPERATOR STACK LAUNCHER
# ==============================================================================
# Self-healing, zero-friction local launcher for Hawa Core API and Hawa Desk PWA.
# Handles port cleanup, healthcheck verification, and auto-browser launch.
# ==============================================================================

set -eo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
BLUE="\033[0;34m"
YELLOW="\033[0;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
RESET="\033[0m"

CORE_PORT=3001
DESK_PORT=4173
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo -e "${CYAN}"
echo "  ██╗  ██╗ █████╗ ██╗    ██╗ █████╗      ██████╗ ███████╗"
echo "  ██║  ██║██╔══██╗██║    ██║██╔══██╗    ██╔═══██╗██╔════╝"
echo "  ███████║███████║██║ █╗ ██║███████║    ██║   ██║███████╗"
echo "  ██╔══██║██╔══██║██║███╗██║██╔══██║    ██║   ██║╚════██║"
echo "  ██║  ██║██║  ██║╚███╔███╔╝██║  ██║    ╚██████╔╝███████║"
echo "  ╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═╝     ╚═════╝ ╚══════╝"
echo -e "${RESET}"
echo -e "${BOLD}Hawa Creative OS — Private Production Stack Launcher${RESET}"
echo -e "Directory: ${BLUE}${PROJECT_DIR}${RESET}\n"

# 1. Pre-flight Environment Checks
echo -e "${BOLD}[1/4] Checking environment prerequisites...${RESET}"
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✗ Error: Node.js is not installed.${RESET}" >&2
  exit 1
fi

NODE_MAJOR=$(node -v | cut -d'.' -f1 | sed 's/[^0-9]//g')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${YELLOW}! Warning: Node.js 20+ recommended. Current: $(node -v)${RESET}"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo -e "${RED}✗ Error: pnpm is not installed.${RESET}" >&2
  exit 1
fi
echo -e "${GREEN}✓ Node $(node -v) and pnpm $(pnpm -v) detected.${RESET}"

# 2. Port Conflict Clean-up (Self-Healing)
echo -e "\n${BOLD}[2/4] Inspecting ports ${CORE_PORT} and ${DESK_PORT}...${RESET}"

cleanup_port() {
  local port=$1
  local pids
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo -e "${YELLOW}  Found process(es) on port ${port} (PID: ${pids}). Clearing...${RESET}"
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

cleanup_port "$CORE_PORT"
cleanup_port "$DESK_PORT"
echo -e "${GREEN}✓ Ports ${CORE_PORT} (Core API) and ${DESK_PORT} (Desk Preview) are clean.${RESET}"

# 3. Ensure Build is Fresh
echo -e "\n${BOLD}[3/4] Ensuring build artifacts are ready...${RESET}"
if [ ! -d "${PROJECT_DIR}/apps/desk/dist" ]; then
  echo -e "${BLUE}  Desk production bundle not found. Building...${RESET}"
  pnpm --filter @hawa/desk build
fi

# 4. Launch Services
echo -e "\n${BOLD}[4/4] Launching Hawa Core API and Desk PWA...${RESET}"

CORE_LOG="${PROJECT_DIR}/.core.log"
DESK_LOG="${PROJECT_DIR}/.desk.log"

# Trap to kill children on SIGINT or SIGTERM
cleanup_children() {
  echo -e "\n\n${YELLOW}Shutting down Hawa Creative OS services...${RESET}"
  if [ -n "$CORE_PID" ]; then kill -TERM "$CORE_PID" 2>/dev/null || true; fi
  if [ -n "$DESK_PID" ]; then kill -TERM "$DESK_PID" 2>/dev/null || true; fi
  cleanup_port "$CORE_PORT"
  cleanup_port "$DESK_PORT"
  echo -e "${GREEN}✓ All services stopped cleanly.${RESET}"
  exit 0
}
trap cleanup_children SIGINT SIGTERM EXIT

# Start Core API
cd "${PROJECT_DIR}"
pnpm --filter @hawa/core dev > "$CORE_LOG" 2>&1 &
CORE_PID=$!
echo -e "  - Hawa Core API started (PID: ${CORE_PID}, logging to .core.log)"

# Start Desk Preview
pnpm --filter @hawa/desk preview --port ${DESK_PORT} > "$DESK_LOG" 2>&1 &
DESK_PID=$!
echo -e "  - Hawa Desk Preview started (PID: ${DESK_PID}, logging to .desk.log)"

# Poll Health
echo -e "\n${BLUE}Waiting for services to become healthy...${RESET}"
CORE_UP=0
DESK_UP=0

for i in {1..30}; do
  if [ $CORE_UP -eq 0 ] && curl -s http://localhost:${CORE_PORT}/v1/health | grep -q '"ok":true' 2>/dev/null; then
    CORE_UP=1
    echo -e "${GREEN}  ✓ Core API online at http://localhost:${CORE_PORT}/v1${RESET}"
  fi

  if [ $DESK_UP -eq 0 ] && curl -s http://localhost:${DESK_PORT} >/dev/null 2>&1; then
    DESK_UP=1
    echo -e "${GREEN}  ✓ Desk UI online at http://localhost:${DESK_PORT}${RESET}"
  fi

  if [ $CORE_UP -eq 1 ] && [ $DESK_UP -eq 1 ]; then
    break
  fi
  sleep 0.5
done

if [ $CORE_UP -eq 0 ] || [ $DESK_UP -eq 0 ]; then
  echo -e "${RED}✗ Warning: One or more services did not respond in time.${RESET}"
  echo -e "Core log tail:"
  tail -n 10 "$CORE_LOG"
  echo -e "Desk log tail:"
  tail -n 10 "$DESK_LOG"
else
  echo -e "\n${GREEN}${BOLD}================================================================"
  echo -e "   HAWA CREATIVE OS IS RUNNING — TRUE 10/10 READY               "
  echo -e "================================================================${RESET}"
  echo -e "  🌐 Desk PWA:     ${CYAN}http://localhost:${DESK_PORT}${RESET}"
  echo -e "  ⚙️  Core API:     ${CYAN}http://localhost:${CORE_PORT}/v1${RESET}"
  echo -e "  📋 Healthcheck:  ${CYAN}http://localhost:${CORE_PORT}/v1/health${RESET}"
  echo -e "  Press ${BOLD}Ctrl+C${RESET} at any time to halt all services cleanly.\n"

  # Auto-open browser on macOS
  if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:${DESK_PORT}" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:${DESK_PORT}" 2>/dev/null || true
  fi
fi

# Wait for processes
wait "$CORE_PID" "$DESK_PID"
