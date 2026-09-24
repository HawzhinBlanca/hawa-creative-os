# Container checks for watchdog.sh, sourced by it (and by packages/testkit/test/watchdog-stack-count.test.ts).
# The caller defines running_names: the names of the running hawa-production containers, one per line.
#
# The stack is six named services: nginx, desk, core, postgres, restate and cutout (ADR-032). They are
# matched by name, not counted as "everything but the worker": the vector log shipper (architecture
# programme 1.4) made a seventh container, and a count of everything let it stand in for a dead desk.
# Vector is checked on its own, because while it is down no container's lines reach ~/.hawa/logs.
# The worker is blue/green (architecture programme 0.1): hawa-production-worker-blue-1 and/or
# -green-1 (both while the old colour drains), or hawa-production-worker-1 before the first
# blue/green deploy.
STACK_SERVICES=(nginx desk core cutout postgres restate)
STACK_SIZE=${#STACK_SERVICES[@]}
STACK_NAME="^hawa-production-($(IFS='|'; echo "${STACK_SERVICES[*]}"))-1\$"
WORKER_NAME='^hawa-production-worker(-blue|-green)?-1$'
VECTOR_NAME='^hawa-production-vector-1$'

count_stack() { running_names | grep -cE "$STACK_NAME" || true; }
count_workers() { running_names | grep -cE "$WORKER_NAME" || true; }
# Not grep -q: it can exit before running_names has written everything, and pipefail then reports
# the writer's SIGPIPE as "not running".
vector_running() { [[ -n "$(running_names | grep -E "$VECTOR_NAME" || true)" ]]; }
# The stack services that are not running, comma-separated (empty when all are).
missing_stack() {
  local names service out=()
  names="$(running_names)"
  for service in "${STACK_SERVICES[@]}"; do
    grep -qx "hawa-production-${service}-1" <<<"$names" || out+=("$service")
  done
  (IFS=,; echo "${out[*]:-}")
}
