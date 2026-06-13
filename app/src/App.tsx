import React, { useEffect, useRef, useState } from "react";
import cfg from "./demo-config.json";
import { fetchAccountData, decodePriceFeed, decodeGuard, positionOpen, usd, Guard } from "./chain";

type Status = "idle" | "live";

export default function App() {
  const [price, setPrice] = useState(cfg.entryPrice);
  const [history, setHistory] = useState<number[]>([cfg.entryPrice]);
  const [guard, setGuard] = useState<Guard | null>(null);
  const [posOpen, setPosOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const seen = useRef<Set<string>>(new Set());

  const addLog = (m: string) => {
    if (seen.current.has(m)) return;
    seen.current.add(m);
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 12));
  };

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [pf, g, pos] = await Promise.all([
          cfg.priceFeed ? fetchAccountData(cfg.rpc, cfg.priceFeed) : null,
          cfg.guard ? fetchAccountData(cfg.rpc, cfg.guard) : null,
          cfg.position ? fetchAccountData(cfg.rpc, cfg.position) : null,
        ]);
        if (!alive) return;
        const feed = decodePriceFeed(pf);
        const gd = decodeGuard(g);
        const open = positionOpen(pos);
        if (feed && feed.price > 0) {
          setStatus("live");
          setPrice((prev) => {
            if (feed.price !== prev) setHistory((h) => [...h, feed.price].slice(-60));
            return feed.price;
          });
        }
        if (open && !posOpen) addLog("📈 Vault opened a Flash position via CPI");
        setPosOpen(open);
        if (gd) {
          setGuard(gd);
          if (gd.triggered && !gd.executed) addLog("⚡ Crank TRIPPED the guard in the rollup — no server");
          if (gd.executed) addLog("✅ execute_protection closed the position (vault-signed CPI)");
        }
      } catch {
        /* validator not up yet */
      }
    };
    const id = setInterval(poll, 400);
    poll();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [posOpen]);

  const liquidated = price <= cfg.liqPrice && status === "live";
  const saved = guard?.executed === true;

  return (
    <div className="min-h-screen text-slate-100 font-mono px-6 py-8 max-w-6xl mx-auto">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            🛡️ Sentinel <span className="text-slate-500 text-lg font-normal">· on-chain stop-loss guardian</span>
          </h1>
          <p className="text-slate-400 mt-1 text-sm">
            Non-custodial liquidation protection for Flash Trade, powered by MagicBlock Ephemeral Rollups.
          </p>
        </div>
        <span className={`text-xs px-3 py-1 rounded-full border ${status === "live" ? "border-emerald-500 text-emerald-400" : "border-slate-600 text-slate-500"}`}>
          {status === "live" ? "● LIVE on-chain" : "○ waiting for driver"}
        </span>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: price */}
        <section className="bg-slate-900/60 rounded-2xl border border-slate-800 p-5">
          <div className="flex justify-between items-baseline mb-3">
            <h2 className="text-slate-400 text-sm uppercase tracking-wide">SOL-PERP price</h2>
            <span className={`text-3xl font-bold ${price <= cfg.stopPrice ? "text-red-400" : "text-slate-100"}`}>{usd(price)}</span>
          </div>
          <PriceChart history={history} entry={cfg.entryPrice} stop={guard?.triggerPrice || cfg.stopPrice} liq={cfg.liqPrice} />
          <div className="flex gap-4 mt-3 text-xs">
            <span className="text-slate-500">entry {usd(cfg.entryPrice)}</span>
            <span className="text-amber-400">stop {usd(guard?.triggerPrice || cfg.stopPrice)}</span>
            <span className="text-red-400">liq {usd(cfg.liqPrice)}</span>
          </div>
        </section>

        {/* RIGHT: two positions */}
        <section className="grid grid-rows-2 gap-6">
          <PositionCard
            title="Unprotected position"
            subtitle="no stop-loss · the usual on-chain fate"
            tone={liquidated ? "dead" : "neutral"}
            badge={liquidated ? "💀 LIQUIDATED" : "open"}
            line={liquidated ? "Price crossed liquidation. Collateral gone." : "Exposed — nobody is watching."}
          />
          <PositionCard
            title="Sentinel-guarded position"
            subtitle="on-chain crank watching · no server"
            tone={saved ? "saved" : posOpen ? "armed" : "neutral"}
            badge={saved ? "🛡️ AUTO-CLOSED — SAVED" : guard?.triggered ? "⚡ closing…" : posOpen ? "protected" : "—"}
            line={
              saved
                ? "Sentinel closed it at the stop. Non-custodial, vault-signed."
                : guard?.triggered
                ? "Guard tripped in the rollup; settling on L1…"
                : posOpen
                ? `Guard armed @ stop ${usd(cfg.stopPrice)}.`
                : "Waiting for position…"
            }
          />
        </section>
      </div>

      {/* event log */}
      <section className="mt-6 bg-black/40 rounded-2xl border border-slate-800 p-4">
        <h2 className="text-slate-500 text-xs uppercase tracking-wide mb-2">on-chain events</h2>
        <div className="space-y-1 text-sm">
          {log.length === 0 && <p className="text-slate-600">Run the demo driver to begin…</p>}
          {log.map((l, i) => (
            <div key={i} className="text-slate-300">{l}</div>
          ))}
        </div>
      </section>

      <footer className="mt-6 text-center text-xs text-slate-600">
        Sentinel program <span className="text-slate-400">{cfg.sentinelProgram.slice(0, 8)}…</span> · venue {cfg.venueProgram.slice(0, 8)}… ·
        the monitoring + decision run entirely on-chain in the rollup with no server.
      </footer>
    </div>
  );
}

function PriceChart({ history, entry, stop, liq }: { history: number[]; entry: number; stop: number; liq: number }) {
  const W = 520, H = 200, pad = 8;
  const hi = entry * 1.04, lo = liq * 0.96;
  const y = (p: number) => pad + (1 - (p - lo) / (hi - lo)) * (H - 2 * pad);
  const x = (i: number, n: number) => pad + (i / Math.max(1, n - 1)) * (W - 2 * pad);
  const pts = history.map((p, i) => `${x(i, history.length)},${y(p)}`).join(" ");
  const last = history[history.length - 1] ?? entry;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-48">
      <line x1={pad} x2={W - pad} y1={y(stop)} y2={y(stop)} stroke="#f59e0b" strokeDasharray="4 4" strokeWidth="1" opacity="0.6" />
      <line x1={pad} x2={W - pad} y1={y(liq)} y2={y(liq)} stroke="#ef4444" strokeDasharray="4 4" strokeWidth="1" opacity="0.6" />
      <polyline points={pts} fill="none" stroke={last <= stop ? "#f87171" : "#38bdf8"} strokeWidth="2.5" strokeLinejoin="round" />
      {history.length > 0 && <circle cx={x(history.length - 1, history.length)} cy={y(last)} r="4" fill={last <= stop ? "#f87171" : "#38bdf8"} />}
    </svg>
  );
}

function PositionCard({ title, subtitle, tone, badge, line }: { title: string; subtitle: string; tone: "neutral" | "dead" | "armed" | "saved"; badge: string; line: string }) {
  const ring =
    tone === "dead" ? "border-red-600 pulse-red" : tone === "saved" ? "border-emerald-500 pulse-green" : tone === "armed" ? "border-sky-700" : "border-slate-800";
  const badgeColor =
    tone === "dead" ? "text-red-400" : tone === "saved" ? "text-emerald-400" : tone === "armed" ? "text-sky-400" : "text-slate-500";
  return (
    <div className={`bg-slate-900/60 rounded-2xl border p-5 transition-all ${ring}`}>
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        <span className={`text-sm font-bold ${badgeColor}`}>{badge}</span>
      </div>
      <p className="text-sm text-slate-400 mt-3">{line}</p>
    </div>
  );
}
