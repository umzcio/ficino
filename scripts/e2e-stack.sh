#!/usr/bin/env bash
# Drives the throwaway loopback e2e stack (docker-compose.e2e.yml, compose project ficino-e2e) and
# runs the Playwright suite against it. Every compose call goes through compose() below, so this
# script can never touch the production project.
#
#   up [--ollama]  build and start the stack, wait until the web answers on 127.0.0.1:$FICINO_E2E_PORT
#                  (--ollama points the providers at the host's Ollama for the full suite)
#   ci             run the gate (project ci) and write tests/results/e2e-ci.json
#   full           seed one real paper, run desktop + mobile, write tests/results/e2e-full.json
#                  (needs a stack started with `up --ollama`)
#   down           stop the stack and remove its containers, network and volumes
#   logs           print the stack's logs
#
# Extra arguments after ci/full go to `playwright test` (for example --grep R9-01).
# Use a fresh `up` for every acceptance run; always finish with `down`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${FICINO_E2E_PORT:-3070}"
export FICINO_E2E_PORT="$PORT"
BASE_URL="http://localhost:${PORT}/ficino/"

compose() { docker compose -p ficino-e2e -f docker-compose.e2e.yml "$@"; }

usage() {
  cat >&2 <<USAGE
usage: scripts/e2e-stack.sh up [--ollama] | ci [playwright args] | full [playwright args] | down | logs
USAGE
}

wait_for_web() {
  local deadline=$((SECONDS + 60))
  until curl -fsS -o /dev/null "$BASE_URL"; do
    if ((SECONDS >= deadline)); then
      echo "e2e-stack: ${BASE_URL} did not answer within 60 s" >&2
      return 1
    fi
    sleep 2
  done
  echo "e2e-stack: up at ${BASE_URL}"
}

# run_suite <report name> [playwright args…]
run_suite() {
  local name="$1"
  shift
  mkdir -p tests/results
  # Always explicit, so a run can never fall back to another stack's containers or port.
  export E2E_BASE_URL="$BASE_URL"
  export E2E_PSQL_CONTAINER=ficino-e2e-postgres
  export E2E_API_CONTAINER=ficino-e2e-api
  # The JSON report lists every skipped test; the gate checks totals and skips against tests/e2e/SKIPS.md.
  export PLAYWRIGHT_JSON_OUTPUT_NAME="tests/results/e2e-${name}.json"
  npx playwright test --reporter=line,json "$@"
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift

case "$cmd" in
  up)
    case "${1:-}" in
      --ollama) export E2E_OLLAMA_BASE_URL="${E2E_OLLAMA_BASE_URL:-http://host.docker.internal:11434}" ;;
      '') ;;
      *) usage; exit 2 ;;
    esac
    compose up -d --build --wait
    wait_for_web
    ;;
  ci)
    run_suite ci --project=ci "$@"
    ;;
  full)
    export E2E_SEED_SAMPLE_PDF=1
    run_suite full --project=desktop --project=mobile "$@"
    ;;
  down)
    compose down -v --remove-orphans
    ;;
  logs)
    compose logs --no-color
    ;;
  *)
    usage
    exit 2
    ;;
esac
