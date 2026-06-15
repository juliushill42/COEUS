#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

log()  { echo -e "${CYAN}[COEUS]${RESET} $1"; }
ok()   { echo -e "${GREEN}[OK]${RESET} $1"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $1"; }
die()  { echo -e "${RED}[FAIL]${RESET} $1"; exit 1; }

echo -e "${BOLD}${CYAN}"
cat << 'EOF'
 ██████╗ ██████╗ ███████╗██╗   ██╗███████╗
██╔════╝██╔═══██╗██╔════╝██║   ██║██╔════╝
██║     ██║   ██║█████╗  ██║   ██║███████╗
██║     ██║   ██║██╔══╝  ██║   ██║╚════██║
╚██████╗╚██████╔╝███████╗╚██████╔╝███████║
 ╚═════╝ ╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝
Topology-Aware Inference Orchestrator — TitanU AI LLC
EOF
echo -e "${RESET}"

MODE="${1:-docker}"

check_deps() {
    log "Checking dependencies..."
    case $MODE in
        docker)
            command -v docker   >/dev/null || die "docker not found"
            command -v docker   >/dev/null && docker compose version >/dev/null 2>&1 || \
                command -v docker-compose >/dev/null || die "docker compose not found"
            ;;
        k8s)
            command -v kubectl  >/dev/null || die "kubectl not found"
            command -v docker   >/dev/null || die "docker not found"
            ;;
        dev)
            command -v cargo    >/dev/null || die "cargo (Rust) not found"
            command -v go       >/dev/null || die "go not found"
            command -v node     >/dev/null || die "node not found"
            command -v npm      >/dev/null || die "npm not found"
            ;;
    esac
    ok "Dependencies satisfied"
}

build_docker() {
    log "Building Docker images..."
    docker build -f deploy/docker/Dockerfile.scheduler -t titanuai/coeus-scheduler:latest .
    docker build -f deploy/docker/Dockerfile.telemetry -t titanuai/coeus-telemetry:latest .
    docker build -f deploy/docker/Dockerfile.router    -t titanuai/coeus-router:latest .
    docker build -f deploy/docker/Dockerfile.dashboard -t titanuai/coeus-dashboard:latest .
    ok "All images built"
}

run_docker() {
    log "Starting COEUS stack..."
    if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
        docker compose up -d
    else
        docker-compose up -d
    fi
    ok "Stack started"
    echo ""
    echo -e "  ${CYAN}Scheduler:${RESET}  http://localhost:8080"
    echo -e "  ${CYAN}Telemetry:${RESET}  http://localhost:8081"
    echo -e "  ${CYAN}KV Router:${RESET}  http://localhost:8082"
    echo -e "  ${CYAN}Dashboard:${RESET}  http://localhost:3000"
    echo ""
}

run_k8s() {
    log "Deploying to Kubernetes..."
    kubectl apply -f deploy/k8s/coeus.yaml
    log "Waiting for pods..."
    kubectl wait --namespace=coeus --for=condition=ready pod \
        --selector=app=coeus-scheduler --timeout=120s || warn "Scheduler pods not ready yet"
    ok "Kubernetes deployment applied"
    echo ""
    kubectl get pods -n coeus
}

run_dev() {
    log "Starting development servers..."

    # Rust scheduler
    log "Building + running coeus-scheduler..."
    (cd . && RUST_LOG=debug cargo run --package coeus-scheduler &)
    SCHEDULER_PID=$!

    # Rust telemetry
    log "Building + running coeus-telemetry..."
    (cd . && COEUS_TELEMETRY_PORT=8081 RUST_LOG=debug cargo run --package coeus-telemetry &)
    TELEMETRY_PID=$!

    # Go router
    log "Running coeus-router..."
    (cd router && go run . &)
    ROUTER_PID=$!

    # Dashboard
    log "Running dashboard..."
    (cd dashboard && npm install --silent && npm run dev &)
    DASH_PID=$!

    ok "All services started"
    echo ""
    echo -e "  PIDs: scheduler=$SCHEDULER_PID telemetry=$TELEMETRY_PID router=$ROUTER_PID dashboard=$DASH_PID"
    echo ""
    echo "Press Ctrl+C to stop all services"
    trap "kill $SCHEDULER_PID $TELEMETRY_PID $ROUTER_PID $DASH_PID 2>/dev/null; ok 'All services stopped'" EXIT
    wait
}

smoke_test() {
    log "Running smoke tests..."
    sleep 3
    curl -sf http://localhost:8080/health > /dev/null && ok "Scheduler health OK" || warn "Scheduler not responding"
    curl -sf http://localhost:8081/health > /dev/null && ok "Telemetry health OK" || warn "Telemetry not responding"
    curl -sf http://localhost:8082/health > /dev/null && ok "Router health OK"    || warn "Router not responding"
}

check_deps

case $MODE in
    docker)
        build_docker
        run_docker
        smoke_test
        ;;
    k8s)
        build_docker
        run_k8s
        ;;
    dev)
        run_dev
        ;;
    *)
        echo "Usage: $0 [docker|k8s|dev]"
        echo "  docker  — build images and run via docker compose (default)"
        echo "  k8s     — build images and deploy to Kubernetes"
        echo "  dev     — run all services locally without Docker"
        exit 1
        ;;
esac
