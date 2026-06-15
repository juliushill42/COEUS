package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

// ── Types ──────────────────────────────────────────────────────────────────

type KvTier string

const (
	TierHBM          KvTier = "hbm"
	TierDRAM         KvTier = "dram"
	TierNVMe         KvTier = "nvme"
	TierHBMDRAMSpill KvTier = "hbm_dram_spill"
	TierDRAMNVMeSpill KvTier = "dram_nvme_spill"
)

type EvictionPolicy string

const (
	EvictLRU      EvictionPolicy = "lru"
	EvictPriority EvictionPolicy = "priority"
	EvictSLA      EvictionPolicy = "sla"
)

type KvEntry struct {
	RequestID    string    `json:"request_id"`
	ModelID      string    `json:"model_id"`
	SequenceID   string    `json:"sequence_id"`
	Tier         KvTier    `json:"tier"`
	SizeBytes    int64     `json:"size_bytes"`
	Priority     int       `json:"priority"`
	SLATtftMs    int64     `json:"sla_ttft_ms"`
	LastAccessed time.Time `json:"last_accessed"`
	CreatedAt    time.Time `json:"created_at"`
	NodeID       string    `json:"node_id"`
	Pinned       bool      `json:"pinned"`
}

type NodeKvState struct {
	NodeID          string    `json:"node_id"`
	HBMTotalBytes   int64     `json:"hbm_total_bytes"`
	HBMUsedBytes    int64     `json:"hbm_used_bytes"`
	DRAMTotalBytes  int64     `json:"dram_total_bytes"`
	DRAMUsedBytes   int64     `json:"dram_used_bytes"`
	NVMeTotalBytes  int64     `json:"nvme_total_bytes"`
	NVMeUsedBytes   int64     `json:"nvme_used_bytes"`
	ActiveSequences int       `json:"active_sequences"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func (n *NodeKvState) HBMFree() int64  { return n.HBMTotalBytes - n.HBMUsedBytes }
func (n *NodeKvState) DRAMFree() int64 { return n.DRAMTotalBytes - n.DRAMUsedBytes }
func (n *NodeKvState) NVMeFree() int64 { return n.NVMeTotalBytes - n.NVMeUsedBytes }

func (n *NodeKvState) PressureScore() float64 {
	if n.HBMTotalBytes == 0 {
		return 1.0
	}
	return float64(n.HBMUsedBytes) / float64(n.HBMTotalBytes)
}

type RouteRequest struct {
	RequestID  string `json:"request_id"`
	ModelID    string `json:"model_id"`
	SequenceID string `json:"sequence_id"`
	NodeID     string `json:"node_id"`
	SizeBytes  int64  `json:"size_bytes"`
	Priority   int    `json:"priority"`
	SLATtftMs  int64  `json:"sla_ttft_ms"`
	Pinned     bool   `json:"pinned"`
}

type RouteDecision struct {
	RequestID        string `json:"request_id"`
	SequenceID       string `json:"sequence_id"`
	AssignedTier     KvTier `json:"assigned_tier"`
	EvictedSequences []string `json:"evicted_sequences"`
	TierPressure     struct {
		HBM  float64 `json:"hbm"`
		DRAM float64 `json:"dram"`
		NVMe float64 `json:"nvme"`
	} `json:"tier_pressure"`
	DecidedAt time.Time `json:"decided_at"`
}

// ── KV Router ──────────────────────────────────────────────────────────────

type KvRouter struct {
	mu       sync.RWMutex
	nodes    map[string]*NodeKvState
	entries  map[string]*KvEntry // key: sequenceID
	policy   EvictionPolicy
	log      *zap.Logger

	// Prometheus
	routeTotal    prometheus.Counter
	evictTotal    prometheus.Counter
	hbmPressure   prometheus.Gauge
	dramPressure  prometheus.Gauge
	nvmePressure  prometheus.Gauge
}

func NewKvRouter(policy EvictionPolicy, log *zap.Logger) *KvRouter {
	reg := prometheus.DefaultRegisterer

	routeTotal := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "coeus_kv_routes_total",
		Help: "Total KV cache routing decisions",
	})
	evictTotal := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "coeus_kv_evictions_total",
		Help: "Total KV cache evictions",
	})
	hbmP := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "coeus_kv_hbm_pressure",
		Help: "Cluster HBM KV pressure [0,1]",
	})
	dramP := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "coeus_kv_dram_pressure",
		Help: "Cluster DRAM KV pressure [0,1]",
	})
	nvmeP := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "coeus_kv_nvme_pressure",
		Help: "Cluster NVMe KV pressure [0,1]",
	})
	reg.MustRegister(routeTotal, evictTotal, hbmP, dramP, nvmeP)

	return &KvRouter{
		nodes:        make(map[string]*NodeKvState),
		entries:      make(map[string]*KvEntry),
		policy:       policy,
		log:          log,
		routeTotal:   routeTotal,
		evictTotal:   evictTotal,
		hbmPressure:  hbmP,
		dramPressure: dramP,
		nvmePressure: nvmeP,
	}
}

func (r *KvRouter) UpdateNode(state NodeKvState) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state.UpdatedAt = time.Now()
	r.nodes[state.NodeID] = &state
	r.updatePressureMetrics()
}

func (r *KvRouter) Route(req RouteRequest) (*RouteDecision, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	node, ok := r.nodes[req.NodeID]
	if !ok {
		return nil, fmt.Errorf("node %s not registered", req.NodeID)
	}

	tier, evicted := r.selectTierWithEviction(node, req)

	entry := &KvEntry{
		RequestID:    req.RequestID,
		ModelID:      req.ModelID,
		SequenceID:   req.SequenceID,
		Tier:         tier,
		SizeBytes:    req.SizeBytes,
		Priority:     req.Priority,
		SLATtftMs:    req.SLATtftMs,
		LastAccessed: time.Now(),
		CreatedAt:    time.Now(),
		NodeID:       req.NodeID,
		Pinned:       req.Pinned,
	}
	r.entries[req.SequenceID] = entry
	r.chargeNode(node, tier, req.SizeBytes)
	r.updatePressureMetrics()
	r.routeTotal.Inc()

	decision := &RouteDecision{
		RequestID:        req.RequestID,
		SequenceID:       req.SequenceID,
		AssignedTier:     tier,
		EvictedSequences: evicted,
		DecidedAt:        time.Now(),
	}
	decision.TierPressure.HBM = float64(node.HBMUsedBytes) / float64(max64(node.HBMTotalBytes, 1))
	decision.TierPressure.DRAM = float64(node.DRAMUsedBytes) / float64(max64(node.DRAMTotalBytes, 1))
	decision.TierPressure.NVMe = float64(node.NVMeUsedBytes) / float64(max64(node.NVMeTotalBytes, 1))

	r.log.Info("kv route",
		zap.String("sequence_id", req.SequenceID),
		zap.String("tier", string(tier)),
		zap.Int("evicted", len(evicted)),
	)

	return decision, nil
}

func (r *KvRouter) selectTierWithEviction(node *NodeKvState, req RouteRequest) (KvTier, []string) {
	var evicted []string

	// Try HBM first (lowest latency)
	if node.HBMFree() >= req.SizeBytes {
		return TierHBM, nil
	}

	// Attempt eviction from HBM to make room
	freed, ev := r.evictFromTier(node, TierHBM, req.SizeBytes-node.HBMFree(), req.Priority)
	evicted = append(evicted, ev...)
	if freed > 0 && node.HBMFree()+freed >= req.SizeBytes {
		return TierHBM, evicted
	}

	// HBM+DRAM spill
	if node.HBMFree()+node.DRAMFree() >= req.SizeBytes {
		return TierHBMDRAMSpill, evicted
	}

	// Pure DRAM
	if node.DRAMFree() >= req.SizeBytes {
		return TierDRAM, evicted
	}

	// DRAM+NVMe spill
	if node.DRAMFree()+node.NVMeFree() >= req.SizeBytes {
		return TierDRAMNVMeSpill, evicted
	}

	// NVMe fallback
	if node.NVMeFree() >= req.SizeBytes {
		return TierNVMe, evicted
	}

	// Force evict lowest priority from DRAM/NVMe
	_, ev2 := r.evictFromTier(node, TierDRAM, req.SizeBytes, req.Priority)
	evicted = append(evicted, ev2...)
	return TierNVMe, evicted
}

func (r *KvRouter) evictFromTier(node *NodeKvState, tier KvTier, neededBytes int64, minPriority int) (int64, []string) {
	type candidate struct {
		seq   string
		entry *KvEntry
		score float64
	}

	var candidates []candidate
	for seq, e := range r.entries {
		if e.NodeID != node.NodeID || e.Tier != tier || e.Pinned {
			continue
		}
		if e.Priority >= minPriority {
			continue
		}
		var score float64
		switch r.policy {
		case EvictLRU:
			score = -float64(time.Since(e.LastAccessed).Milliseconds())
		case EvictPriority:
			score = float64(e.Priority)
		case EvictSLA:
			score = float64(e.Priority)*0.5 - float64(time.Since(e.LastAccessed).Milliseconds())*0.5
		}
		candidates = append(candidates, candidate{seq: seq, entry: e, score: score})
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score < candidates[j].score
	})

	var freed int64
	var evicted []string
	for _, c := range candidates {
		if freed >= neededBytes {
			break
		}
		freed += c.entry.SizeBytes
		r.releaseNode(node, c.entry.Tier, c.entry.SizeBytes)
		delete(r.entries, c.seq)
		evicted = append(evicted, c.seq)
		r.evictTotal.Inc()
	}
	return freed, evicted
}

func (r *KvRouter) chargeNode(node *NodeKvState, tier KvTier, bytes int64) {
	switch tier {
	case TierHBM:
		node.HBMUsedBytes += bytes
	case TierDRAM:
		node.DRAMUsedBytes += bytes
	case TierNVMe:
		node.NVMeUsedBytes += bytes
	case TierHBMDRAMSpill:
		hbm := node.HBMFree()
		node.HBMUsedBytes += hbm
		node.DRAMUsedBytes += bytes - hbm
	case TierDRAMNVMeSpill:
		dram := node.DRAMFree()
		node.DRAMUsedBytes += dram
		node.NVMeUsedBytes += bytes - dram
	}
}

func (r *KvRouter) releaseNode(node *NodeKvState, tier KvTier, bytes int64) {
	switch tier {
	case TierHBM, TierHBMDRAMSpill:
		node.HBMUsedBytes = max64(0, node.HBMUsedBytes-bytes)
	case TierDRAM, TierDRAMNVMeSpill:
		node.DRAMUsedBytes = max64(0, node.DRAMUsedBytes-bytes)
	case TierNVMe:
		node.NVMeUsedBytes = max64(0, node.NVMeUsedBytes-bytes)
	}
}

func (r *KvRouter) Release(sequenceID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[sequenceID]
	if !ok {
		return false
	}
	if node, exists := r.nodes[entry.NodeID]; exists {
		r.releaseNode(node, entry.Tier, entry.SizeBytes)
	}
	delete(r.entries, sequenceID)
	r.updatePressureMetrics()
	return true
}

func (r *KvRouter) Touch(sequenceID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.entries[sequenceID]; ok {
		e.LastAccessed = time.Now()
	}
}

func (r *KvRouter) NodeStates() []*NodeKvState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*NodeKvState, 0, len(r.nodes))
	for _, n := range r.nodes {
		cp := *n
		out = append(out, &cp)
	}
	return out
}

func (r *KvRouter) updatePressureMetrics() {
	var hbmUsed, hbmTotal, dramUsed, dramTotal, nvmeUsed, nvmeTotal int64
	for _, n := range r.nodes {
		hbmUsed += n.HBMUsedBytes
		hbmTotal += n.HBMTotalBytes
		dramUsed += n.DRAMUsedBytes
		dramTotal += n.DRAMTotalBytes
		nvmeUsed += n.NVMeUsedBytes
		nvmeTotal += n.NVMeTotalBytes
	}
	if hbmTotal > 0 {
		r.hbmPressure.Set(float64(hbmUsed) / float64(hbmTotal))
	}
	if dramTotal > 0 {
		r.dramPressure.Set(float64(dramUsed) / float64(dramTotal))
	}
	if nvmeTotal > 0 {
		r.nvmePressure.Set(float64(nvmeUsed) / float64(nvmeTotal))
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ── HTTP Server ────────────────────────────────────────────────────────────

func buildRouter(kv *KvRouter, log *zap.Logger) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok", "service": "coeus-router"})
	})

	r.Post("/api/v1/route", func(w http.ResponseWriter, r *http.Request) {
		var req RouteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		if req.SequenceID == "" {
			req.SequenceID = uuid.New().String()
		}
		decision, err := kv.Route(req)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, decision)
	})

	r.Post("/api/v1/nodes", func(w http.ResponseWriter, r *http.Request) {
		var state NodeKvState
		if err := json.NewDecoder(r.Body).Decode(&state); err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		kv.UpdateNode(state)
		w.WriteHeader(201)
	})

	r.Delete("/api/v1/sequences/{seq_id}", func(w http.ResponseWriter, r *http.Request) {
		seqID := chi.URLParam(r, "seq_id")
		if kv.Release(seqID) {
			w.WriteHeader(204)
		} else {
			writeJSON(w, 404, map[string]string{"error": "sequence not found"})
		}
	})

	r.Post("/api/v1/sequences/{seq_id}/touch", func(w http.ResponseWriter, r *http.Request) {
		seqID := chi.URLParam(r, "seq_id")
		kv.Touch(seqID)
		w.WriteHeader(200)
	})

	r.Get("/api/v1/nodes", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, kv.NodeStates())
	})

	r.Handle("/metrics", promhttp.Handler())

	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	port := os.Getenv("COEUS_ROUTER_PORT")
	if port == "" {
		port = "8082"
	}

	policy := EvictionPolicy(os.Getenv("COEUS_EVICTION_POLICY"))
	if policy == "" {
		policy = EvictSLA
	}

	kv := NewKvRouter(policy, log)
	handler := buildRouter(kv, log)

	log.Info("COEUS KV router listening", zap.String("port", port), zap.String("policy", string(policy)))
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal("server error", zap.Error(err))
	}
}
