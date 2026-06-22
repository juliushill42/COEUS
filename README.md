

---

# 🐳 COEUS: Production Deployment & Containerization Stack

This repository contains the production-ready Docker infrastructure for the **COEUS Topology-Aware Inference Orchestrator**.

Because COEUS is a polyglot microservice architecture (Rust, Go, and Node.js/React), standardizing the deployment environment is critical. This build utilizes highly optimized, multi-stage Dockerfiles and a unified Docker Compose network to guarantee reproducible, isolated, and ultra-lightweight execution across any host machine.

---

## 🏗️ Container Architecture & Optimizations

This stack is engineered to minimize attack surfaces and drastically reduce image bloat by compiling in heavy environments and running in minimal ones.

### 1. KV Router (Golang)

* 
**Builder:** Golang 1.22 Alpine environment.


* 
**Optimization:** The Go code is compiled as a standalone, statically linked Linux binary.


* 
**Runtime:** It is deployed into a completely empty `scratch` image, resulting in a final container size of just a few megabytes with zero operating system vulnerabilities.



### 2. Scheduler & Telemetry (Rust)

* 
**Builder:** Rust 1.79 Slim environment.


* **Optimization:** Compiling Rust takes time. To prevent Docker from re-downloading and re-compiling the entire dependency tree on every code change, these Dockerfiles use a "dummy `main.rs`" caching trick. This isolates the dependency build from the source code build.


* **Runtime:** Deployed into a stripped-down `debian:bookworm-slim` image to retain standard C-libraries (like OpenSSL) while keeping the footprint minimal.

### 3. Dashboard (Node/React)

* 
**Builder:** Node 20 Alpine environment.


* 
**Optimization:** The React codebase is compiled into static HTML/JS/CSS assets via `npm run build`.


* **Runtime:** The heavy Node environment is completely discarded. The static assets are served using a highly efficient `nginx:alpine` web server, utilizing a custom `nginx.conf` to natively handle Single Page Application (SPA) routing and gzip compression.

---

## 🚀 Orchestration (Docker Compose)

The entire microservice grid is orchestrated via `docker-compose.yml`.

It handles:

* **Internal Networking:** The dashboard automatically resolves the backend APIs (`http://localhost:8080`, `http://localhost:8081`, `http://localhost:8082`).
* **Health Checks:** Native `wget` health probes verify that endpoints return a 200 OK status before marking services as healthy.
* **Auto-Recovery:** Services are set to `restart: unless-stopped`, ensuring the cluster automatically recovers from host reboots or fatal crashes.

---

## 💻 Quick Start Guide

**Prerequisites:**

* Docker installed and running on your host machine.
* Docker Compose installed.

**1. Build and Launch the Stack**
Run the following command from the root directory to build the images and launch the containers in the background:

```bash
docker compose up -d --build

```

**2. Verify Cluster Health**
Ensure all 4 containers are marked as "Up" and "Healthy":

```bash
docker compose ps

```

**3. Access the Grid**

* **Dashboard:** `http://localhost:3000`
* **Scheduler API:** `http://localhost:8080`
* **Telemetry API:** `http://localhost:8081`
* **KV Router API:** `http://localhost:8082`

**4. Graceful Teardown**
To stop the cluster and safely release the network ports without deleting your built images:

```bash
docker compose down

```
