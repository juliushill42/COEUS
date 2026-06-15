import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, RadialBarChart, RadialBar
} from "recharts";
import {
  Cpu, Activity, AlertTriangle, CheckCircle, Server,
  Zap, Database, Network, RefreshCw, TrendingUp
} from "lucide-react";

const SCHEDULER_URL = import.meta.env.VITE_SCHEDULER_URL || "http://localhost:8080";
const TELEMETRY_URL = import.meta.env.VITE_TELEMETRY_URL || "http://localhost:8081";
const ROUTER_URL = import.meta.env.VITE_ROUTER_URL || "http://localhost:8082";

const C = {
  bg: "#080c14",
  surface: "#0d1424",
  border: "#1a2540",
  accent: "#00c8ff",
  accentDim: "#0066aa",
  warn: "#ff8c00",
  danger: "#ff2d55",
  ok: "#00e676",
  text: "#e2e8f0",
  muted: "#64748b",
  titan: "#7c3aed",
};

const px = (style) => Object.fromEntries(
  Object.entries(style).map(([k, v]) => [k, v])
);

function Card({ children, style }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: 20, ...style
    }}>
      {children}
    </div>
  );
}

function Label({ children, color }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: 2,
      textTransform: "uppercase", color: color || C.muted
    }}>
      {children}
    </span>
  );
}

function Badge({ children, color }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: "2px 8px",
      borderRadius: 4, background: `${color || C.accent}22`,
      color: color || C.accent, border: `1px solid ${color || C.accent}44`
    }}>
      {children}
    </span>
  );
}

function MetricCard({ label, value, unit, icon: Icon, color, sub }) {
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <Label>{label}</Label>
          <div style={{ marginTop: 8, fontSize: 32, fontWeight: 800, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>
            {value}<span style={{ fontSize: 14, color: C.muted, marginLeft: 4 }}>{unit}</span>
          </div>
          {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{sub}</div>}
        </div>
        {Icon && (
          <div style={{
            width: 40, height: 40, borderRadius: 8,
            background: `${color || C.accent}18`,
            display: "flex", alignItems: "center", justifyContent: "center"
          }}>
            <Icon size={20} color={color || C.accent} />
          </div>
        )}
      </div>
    </Card>
  );
}

function NodeRow({ node }) {
  const hbmUsed = node.gpus?.reduce((s, g) => s + (g.hbm_total_bytes - g.hbm_free_bytes), 0) || 0;
  const hbmTotal = node.gpus?.reduce((s, g) => s + g.hbm_total_bytes, 0) || 1;
  const hbmPct = Math.round((hbmUsed / hbmTotal) * 100);
  const gpuUtil = node.gpus?.length
    ? Math.round(node.gpus.reduce((s, g) => s + g.compute_util_pct, 0) / node.gpus.length)
    : 0;
  const nvlink = node.gpus?.some(g => g.nvlink_domain);

  const classColor = {
    PrefillPrimary: C.accent,
    DecodePrimary: C.titan,
    HybridEdge: C.ok,
    CpuBurst: C.warn,
  }[node.class] || C.muted;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "180px 120px 80px 1fr 1fr 80px 60px",
      alignItems: "center", gap: 12,
      padding: "12px 16px",
      borderBottom: `1px solid ${C.border}`,
      fontSize: 13,
    }}>
      <div>
        <div style={{ fontWeight: 600, color: C.text }}>{node.hostname}</div>
        <div style={{ fontSize: 11, color: C.muted }}>{node.node_id?.slice(0, 8)}…</div>
      </div>
      <Badge color={classColor}>{node.class}</Badge>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: node.healthy ? C.ok : C.danger
        }} />
        <span style={{ color: node.healthy ? C.ok : C.danger }}>
          {node.healthy ? "Live" : "Down"}
        </span>
      </div>
      <ProgressBar value={hbmPct} color={hbmPct > 85 ? C.danger : hbmPct > 65 ? C.warn : C.accent} label={`HBM ${hbmPct}%`} />
      <ProgressBar value={gpuUtil} color={gpuUtil > 90 ? C.danger : C.ok} label={`GPU ${gpuUtil}%`} />
      <div style={{ color: nvlink ? C.ok : C.muted, fontSize: 12 }}>
        {nvlink ? "✓ NVLink" : "PCIe"}
      </div>
      <div style={{ color: C.muted }}>{node.active_requests || 0}</div>
    </div>
  );
}

function ProgressBar({ value, color, label }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>{label}</div>
      <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${Math.min(value, 100)}%`,
          background: color, borderRadius: 3,
          transition: "width 0.4s ease"
        }} />
      </div>
    </div>
  );
}

function CausalChart({ data }) {
  if (!data?.length) return <div style={{ color: C.muted, fontSize: 13 }}>No causal data yet.</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical" margin={{ left: 20, right: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis type="number" tick={{ fill: C.muted, fontSize: 11 }} />
        <YAxis type="category" dataKey="category" tick={{ fill: C.muted, fontSize: 10 }} width={160} />
        <Tooltip
          contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 }}
          labelStyle={{ color: C.text }}
        />
        <Bar dataKey="total_latency_added_ms" name="Total ms Added" fill={C.danger} radius={[0, 4, 4, 0]} />
        <Bar dataKey="occurrence_count" name="Occurrences" fill={C.warn} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function TtftChart({ history }) {
  if (!history?.length) return <div style={{ color: C.muted, fontSize: 13 }}>Waiting for traces…</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={history}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="t" tick={{ fill: C.muted, fontSize: 10 }} />
        <YAxis tick={{ fill: C.muted, fontSize: 10 }} unit="ms" />
        <Tooltip
          contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 }}
          labelStyle={{ color: C.text }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="ttft" name="TTFT (ms)" stroke={C.accent} dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="sla" name="SLA (ms)" stroke={C.warn} dot={false} strokeDasharray="4 4" strokeWidth={1} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function App() {
  const [nodes, setNodes] = useState([]);
  const [stats, setStats] = useState({ sla_breach_rate: 0, p99_ttft_ms: 0 });
  const [causal, setCausal] = useState([]);
  const [traces, setTraces] = useState([]);
  const [ttftHistory, setTtftHistory] = useState([]);
  const [kvNodes, setKvNodes] = useState([]);
  const [tab, setTab] = useState("cluster");
  const [lastRefresh, setLastRefresh] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [topoRes, statsRes, causalRes, tracesRes, kvRes] = await Promise.allSettled([
        fetch(`${SCHEDULER_URL}/api/v1/topology`),
        fetch(`${TELEMETRY_URL}/api/v1/stats`),
        fetch(`${TELEMETRY_URL}/api/v1/causality`),
        fetch(`${TELEMETRY_URL}/api/v1/traces?limit=50`),
        fetch(`${ROUTER_URL}/api/v1/nodes`),
      ]);

      if (topoRes.status === "fulfilled" && topoRes.value.ok) {
        const d = await topoRes.value.json();
        setNodes(d.nodes || []);
      }
      if (statsRes.status === "fulfilled" && statsRes.value.ok) {
        setStats(await statsRes.value.json());
      }
      if (causalRes.status === "fulfilled" && causalRes.value.ok) {
        setCausal(await causalRes.value.json());
      }
      if (tracesRes.status === "fulfilled" && tracesRes.value.ok) {
        const t = await tracesRes.value.json();
        setTraces(t || []);
        // Build TTFT history
        const hist = (t || []).slice(0, 30).reverse().map((tr, i) => ({
          t: i + 1,
          ttft: tr.total_ttft_ms,
          sla: tr.sla_ttft_ms,
        }));
        setTtftHistory(hist);
      }
      if (kvRes.status === "fulfilled" && kvRes.value.ok) {
        setKvNodes(await kvRes.value.json());
      }
    } catch (e) {
      console.error("fetch error", e);
    } finally {
      setLoading(false);
      setLastRefresh(new Date().toLocaleTimeString());
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 5000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  const healthyNodes = nodes.filter(n => n.healthy).length;
  const nvlinkNodes = nodes.filter(n => n.gpus?.some(g => g.nvlink_domain)).length;
  const breachPct = Math.round((stats.sla_breach_rate || 0) * 100);

  const tabs = ["cluster", "telemetry", "kv cache", "traces"];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{
        background: C.surface, borderBottom: `1px solid ${C.border}`,
        padding: "0 32px", display: "flex", alignItems: "center",
        justifyContent: "space-between", height: 60
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: `linear-gradient(135deg, ${C.titan}, ${C.accent})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 900
          }}>C</div>
          <div>
            <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: 1 }}>COEUS</span>
            <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>Topology-Aware Inference Orchestrator</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {lastRefresh && <span style={{ color: C.muted, fontSize: 12 }}>Updated {lastRefresh}</span>}
          <button
            onClick={fetchAll}
            style={{
              background: "transparent", border: `1px solid ${C.border}`,
              borderRadius: 8, padding: "6px 12px", color: C.text,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13
            }}
          >
            <RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
            Refresh
          </button>
        </div>
      </div>

      {/* Top metrics */}
      <div style={{ padding: "24px 32px 0" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
          <MetricCard
            label="Healthy Nodes"
            value={healthyNodes}
            unit={`/ ${nodes.length}`}
            icon={Server}
            color={healthyNodes === nodes.length ? C.ok : C.warn}
            sub="Active in cluster"
          />
          <MetricCard
            label="P99 TTFT"
            value={stats.p99_ttft_ms || 0}
            unit="ms"
            icon={Activity}
            color={stats.p99_ttft_ms > 500 ? C.danger : C.accent}
            sub="Time to first token"
          />
          <MetricCard
            label="SLA Breach Rate"
            value={breachPct}
            unit="%"
            icon={breachPct > 5 ? AlertTriangle : CheckCircle}
            color={breachPct > 5 ? C.danger : C.ok}
            sub="Last 1000 requests"
          />
          <MetricCard
            label="NVLink Nodes"
            value={nvlinkNodes}
            unit={`/ ${nodes.length}`}
            icon={Zap}
            color={C.titan}
            sub="High-bandwidth fabric"
          />
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
          {tabs.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: "pointer", textTransform: "capitalize",
                background: tab === t ? `${C.accent}18` : "transparent",
                border: tab === t ? `1px solid ${C.accent}44` : `1px solid transparent`,
                color: tab === t ? C.accent : C.muted,
                transition: "all 0.15s"
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === "cluster" && (
          <div>
            <Card style={{ marginBottom: 16 }}>
              <Label>Cluster Node Registry</Label>
              <div style={{
                display: "grid",
                gridTemplateColumns: "180px 120px 80px 1fr 1fr 80px 60px",
                gap: 12, padding: "8px 16px",
                borderBottom: `1px solid ${C.border}`, marginTop: 12
              }}>
                {["Host", "Class", "Status", "HBM", "GPU Util", "Fabric", "Reqs"].map(h => (
                  <Label key={h}>{h}</Label>
                ))}
              </div>
              {nodes.length === 0 ? (
                <div style={{ padding: 32, textAlign: "center", color: C.muted }}>
                  No nodes registered. POST to /api/v1/nodes on the scheduler.
                </div>
              ) : (
                nodes.map(n => <NodeRow key={n.node_id} node={n} />)
              )}
            </Card>
          </div>
        )}

        {tab === "telemetry" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Card>
              <Label>TTFT Over Time</Label>
              <div style={{ marginTop: 16 }}>
                <TtftChart history={ttftHistory} />
              </div>
            </Card>
            <Card>
              <Label>Causal Latency Attribution</Label>
              <div style={{ marginTop: 16 }}>
                <CausalChart data={causal} />
              </div>
            </Card>
          </div>
        )}

        {tab === "kv cache" && (
          <div>
            {kvNodes.length === 0 ? (
              <Card>
                <div style={{ padding: 24, textAlign: "center", color: C.muted }}>
                  No KV node state. POST to /api/v1/nodes on the router.
                </div>
              </Card>
            ) : (
              kvNodes.map(node => (
                <Card key={node.node_id} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <div>
                      <Label>Node</Label>
                      <div style={{ fontWeight: 700, marginTop: 4 }}>{node.node_id}</div>
                    </div>
                    <Badge>{node.active_sequences} sequences</Badge>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                    <div>
                      <Label color={C.accent}>HBM</Label>
                      <ProgressBar
                        value={Math.round((node.hbm_used_bytes / Math.max(node.hbm_total_bytes, 1)) * 100)}
                        color={C.accent}
                        label={`${Math.round(node.hbm_used_bytes / 1e9)}GB / ${Math.round(node.hbm_total_bytes / 1e9)}GB`}
                      />
                    </div>
                    <div>
                      <Label color={C.titan}>DRAM</Label>
                      <ProgressBar
                        value={Math.round((node.dram_used_bytes / Math.max(node.dram_total_bytes, 1)) * 100)}
                        color={C.titan}
                        label={`${Math.round(node.dram_used_bytes / 1e9)}GB / ${Math.round(node.dram_total_bytes / 1e9)}GB`}
                      />
                    </div>
                    <div>
                      <Label color={C.warn}>NVMe</Label>
                      <ProgressBar
                        value={Math.round((node.nvme_used_bytes / Math.max(node.nvme_total_bytes, 1)) * 100)}
                        color={C.warn}
                        label={`${Math.round(node.nvme_used_bytes / 1e9)}GB / ${Math.round(node.nvme_total_bytes / 1e9)}GB`}
                      />
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === "traces" && (
          <Card>
            <Label>Recent Request Traces</Label>
            <div style={{ marginTop: 12, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["Request ID", "TTFT (ms)", "SLA (ms)", "NVLink", "PCIe Cross", "SLA", "Top Cause"].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.muted, fontWeight: 600 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {traces.length === 0 ? (
                    <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: C.muted }}>No traces yet.</td></tr>
                  ) : traces.map(tr => (
                    <tr key={tr.request_id} style={{ borderBottom: `1px solid ${C.border}22` }}>
                      <td style={{ padding: "8px 12px", color: C.muted }}>{tr.request_id?.slice(0, 12)}…</td>
                      <td style={{ padding: "8px 12px", color: tr.sla_breached ? C.danger : C.ok, fontWeight: 700 }}>
                        {tr.total_ttft_ms}
                      </td>
                      <td style={{ padding: "8px 12px" }}>{tr.sla_ttft_ms}</td>
                      <td style={{ padding: "8px 12px", color: tr.nvlink_path ? C.ok : C.muted }}>
                        {tr.nvlink_path ? "✓" : "✗"}
                      </td>
                      <td style={{ padding: "8px 12px", color: tr.crossed_pcie ? C.warn : C.ok }}>
                        {tr.crossed_pcie ? "⚠ Yes" : "No"}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <Badge color={tr.sla_breached ? C.danger : C.ok}>
                          {tr.sla_breached ? "BREACH" : "OK"}
                        </Badge>
                      </td>
                      <td style={{ padding: "8px 12px", color: C.muted, maxWidth: 200 }}>
                        {tr.causal_roots?.[0]?.category || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <div style={{ height: 40 }} />
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${C.bg}; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${C.surface}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
      `}</style>
    </div>
  );
}
