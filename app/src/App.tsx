import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection } from "@solana/web3.js";
import { makeClient, Rule, ProtectParams } from "./sentinel";
import { CLUSTERS, ClusterKey, fromUnits } from "./config";
import Landing from "./Landing";
import { MarketChart, Sparkline } from "./Chart";
import * as I from "./icons";

const trunc = (s: string, n = 4) => (s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
const RULES: { key: Rule; label: string }[] = [
  { key: "stop", label: "Stop-loss" },
  { key: "takeProfit", label: "Take-profit" },
  { key: "trailing", label: "Trailing" },
];
const timeStr = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).toUpperCase();
const sideLabel = (s: number) => (s === 2 ? "SHORT" : "LONG");
const isStopType = (g: any) => !g.rule?.priceAbove;
// Fraction of the entry→stop band still remaining (1 = at entry / safe, 0 = at the stop).
function stopBuffer(g: any) {
  const entry = fromUnits(g.entryPrice), stop = fromUnits(g.triggerPrice), last = fromUnits(g.lastPrice);
  const span = entry - stop;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (last - stop) / span));
}
const pct = (entry: number, other: number) => (entry > 0 ? ((other - entry) / entry) * 100 : 0);

export default function App({ cluster, setCluster }: { cluster: ClusterKey; setCluster: (c: ClusterKey) => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const erConn = useMemo(() => (CLUSTERS[cluster].er ? new Connection(CLUSTERS[cluster].er) : undefined), [cluster]);
  const client = useMemo(
    () => (wallet.publicKey && wallet.signTransaction ? makeClient(connection, wallet as any, erConn) : null),
    [connection, wallet.publicKey?.toBase58(), erConn],
  );

  const [guards, setGuards] = useState<any[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [hist, setHist] = useState<Record<string, number[]>>({});
  const [tab, setTab] = useState("guards");
  // The landing page is always the first screen — even if autoConnect silently
  // reconnects a wallet. The user explicitly clicks "Launch app" to enter the dashboard.
  const [entered, setEntered] = useState(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoadErr(false);
    try { setGuards(await client.listGuards()); }
    catch { setLoadErr(true); setGuards([]); }
  }, [client]);
  useEffect(() => { if (client) { setGuards(null); refresh(); } else setGuards(null); }, [client, refresh]);
  // Live: re-poll guards so crank updates (last price, triggered) show without a manual refresh.
  useEffect(() => { if (!client) return; const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [client, refresh]);
  // Accumulate a price-history series per guard for the live chart + sparklines.
  useEffect(() => {
    if (!guards) return;
    setHist((prev) => {
      const next = { ...prev };
      for (const g of guards) {
        const k = g.pubkey.toBase58();
        const arr = (next[k] ?? []).slice(-79);
        arr.push(fromUnits(g.lastPrice));
        next[k] = arr;
      }
      return next;
    });
  }, [guards]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const run = (label: string, fn: () => Promise<any>) => async () => {
    setBusy(label); setToast(null);
    try { await fn(); setToast({ kind: "ok", msg: `${label} confirmed` }); await refresh(); }
    catch (e: any) { setToast({ kind: "err", msg: `${label} failed — ${e?.message ?? e}` }); }
    finally { setBusy(""); }
  };

  if (!entered || !wallet.publicKey) return <Landing onLaunch={() => setEntered(true)} />;
  const focus = guards?.find((g: any) => g.active && !g.executed) ?? guards?.[0];

  return (
    <div className="min-h-screen bg-black text-white font-sans flex flex-col selection:bg-white selection:text-black">
      <NavBar cluster={cluster} setCluster={setCluster} live={!!CLUSTERS[cluster].er} />
      <VaultStrip client={client} cluster={cluster} guards={guards} />
      <TabBar tab={tab} setTab={setTab} />
      <main className="flex-1 w-full max-w-6xl mx-auto px-6 md:px-10 lg:px-14 py-8 space-y-px">
        {tab === "guards" && (
          <>
            {focus && <MarketPanel g={focus} history={hist[focus.pubkey.toBase58()] ?? []} />}
            <div className="grid lg:grid-cols-5 gap-px bg-white/10 border border-white/10">
              <div className="lg:col-span-2 bg-black"><ProtectionForm busy={busy} run={run} client={client} hasEr={!!CLUSTERS[cluster].er} /></div>
              <div className="lg:col-span-3 bg-black"><GuardsPanel guards={guards} hist={hist} loadErr={loadErr} busy={busy} run={run} client={client} refresh={refresh} /></div>
            </div>
            <Analytics guards={guards} />
          </>
        )}
        {tab === "grid" && <GridPanel client={client} busy={busy} run={run} />}
        {tab === "copy" && <CopyPanel client={client} busy={busy} run={run} />}
        {tab === "portfolio" && <PortfolioPanel client={client} guards={guards} busy={busy} run={run} />}
      </main>
      <Footer cluster={cluster} />
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

const TABS = [["guards", "Guards"], ["grid", "Grid / DCA"], ["copy", "Copy trading"], ["portfolio", "Portfolio"]] as const;
function TabBar({ tab, setTab }: { tab: string; setTab: (t: string) => void }) {
  return (
    <div className="border-b border-white/10">
      <div className="max-w-6xl mx-auto px-6 md:px-10 lg:px-14 flex gap-6">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`anim py-3.5 text-sm border-b-2 -mb-px ${tab === k ? "border-white text-white font-medium" : "border-transparent text-white/45 hover:text-white"}`}>{label}</button>
        ))}
      </div>
    </div>
  );
}

/* ---------- nav ---------- */
function NavBar({ cluster, setCluster, live }: { cluster: ClusterKey; setCluster: (c: ClusterKey) => void; live: boolean }) {
  const [clock, setClock] = useState(timeStr());
  useEffect(() => { const t = setInterval(() => setClock(timeStr()), 1000); return () => clearInterval(t); }, []);
  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-black/85 backdrop-blur">
      <div className="max-w-6xl mx-auto px-6 md:px-10 lg:px-14 h-16 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="grid place-items-center h-9 w-9 rounded-md border border-white/20"><I.Shield size={18} /></span>
          <span className="text-lg font-bold tracking-[0.18em]">SENTINEL</span>
          <span className="hidden md:block font-mono text-[10px] tracking-widest text-white/40 uppercase">Dashboard</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden lg:block font-mono text-[11px] tracking-widest text-white/45 tnum">{clock}</span>
          <label className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-success live-dot" : "bg-white/30"}`} />
            <select value={cluster} onChange={(e) => setCluster(e.target.value as ClusterKey)}
              className="anim bg-transparent border border-white/15 rounded-md px-2.5 py-2 text-xs hover:border-white/40 [&>option]:bg-black">
              {Object.entries(CLUSTERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

function WalletButton() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const [open, setOpen] = useState(false);
  const base = "anim inline-flex items-center gap-2 rounded-full px-4 h-10 text-sm font-medium";
  if (connecting) return <button disabled className={`${base} border border-white/15 text-white/50`}><I.Spinner /> Connecting…</button>;
  if (!publicKey) return <button onClick={() => setVisible(true)} className={`${base} bg-white text-black hover:bg-white/90`}>Connect</button>;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className={`${base} border border-white/20 hover:border-white/40 font-mono tnum`}>
        <span className="h-2 w-2 rounded-full bg-success" /> {trunc(publicKey.toBase58())}
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-10 cursor-default" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 z-20 w-44 border border-white/15 bg-black p-1">
            <MenuItem onClick={() => { navigator.clipboard?.writeText(publicKey.toBase58()); setOpen(false); }}><I.Copy size={15} /> Copy address</MenuItem>
            <MenuItem onClick={() => { disconnect(); setOpen(false); }}>Disconnect</MenuItem>
          </div>
        </>
      )}
    </div>
  );
}
const MenuItem = ({ children, onClick }: any) => (
  <button onClick={onClick} className="anim w-full flex items-center gap-2 text-left text-sm px-2.5 py-2 text-white/85 hover:bg-white/[0.06]">{children}</button>
);

/* ---------- vault strip ---------- */
function VaultStrip({ client, cluster, guards }: any) {
  const list = guards ?? [];
  const active = list.filter((g: any) => g.active);
  const protectedN = list.filter((g: any) => g.executed).length;
  const atRisk = active.filter((g: any) => !g.triggered && isStopType(g) && stopBuffer(g) < 0.25).length;
  const v = client?.vault?.toBase58?.() ?? "";
  return (
    <div className="border-b border-white/10">
      <div className="max-w-6xl mx-auto px-6 md:px-10 lg:px-14 py-4 grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-x-10 gap-y-4">
        <Stat label="Vault" value={<span className="font-mono tnum">{trunc(v)}</span>}
          action={<button aria-label="Copy vault address" className="anim text-white/40 hover:text-white p-1 -m-1" onClick={() => navigator.clipboard?.writeText(v)}><I.Copy size={13} /></button>} />
        <Stat label="Active" value={<span className="tnum">{guards == null ? "—" : active.length}</span>} />
        <Stat label="Protected" value={<span className="tnum text-success">{guards == null ? "—" : protectedN}</span>} />
        <Stat label="At risk" value={<span className={`tnum ${atRisk > 0 ? "text-warn" : ""}`}>{guards == null ? "—" : atRisk}</span>} />
        <Stat label="Network" value={CLUSTERS[cluster].label} />
        <div className="ml-auto hidden sm:flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-white/35">
          <span className="h-1.5 w-1.5 rounded-full bg-success live-dot" /> Live · refreshing 5s
        </div>
      </div>
    </div>
  );
}
const Stat = ({ label, value, action }: any) => (
  <div>
    <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">{label}</div>
    <div className="mt-1 flex items-center gap-2 text-sm font-medium">{value}{action}</div>
  </div>
);

/* ---------- featured live market chart ---------- */
function MarketPanel({ g, history }: any) {
  const entry = fromUnits(g.entryPrice), stop = fromUnits(g.triggerPrice), tp = fromUnits(g.tpPrice), last = fromUnits(g.lastPrice);
  const up = last >= entry, delta = pct(entry, last);
  const id = Number(g.guardId);
  const st = g.executed ? ["Protected", "text-success"] : g.triggered ? ["Firing", "text-warn"] : g.active ? ["Armed", "text-white/70"] : ["Closed", "text-white/40"];
  return (
    <section className="border border-white/10 bg-black">
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 md:px-7 pt-6 pb-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">
            [ Market ] SOL-PERP · {sideLabel(g.side)} · guard #{id}
          </div>
          <div className="mt-1.5 flex items-baseline gap-3">
            <span className={`font-mono tnum text-3xl md:text-4xl font-semibold ${up ? "text-success" : "text-danger"}`}>${last.toFixed(2)}</span>
            <span className={`font-mono tnum text-sm ${up ? "text-success" : "text-danger"}`}>{delta >= 0 ? "+" : ""}{delta.toFixed(2)}%</span>
          </div>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest">
          <span className="text-white/50">entry ${entry.toFixed(2)}</span>
          <span className="text-danger/80">stop ${stop.toFixed(2)}</span>
          {tp > 0 && <span className="text-success/80">tp ${tp.toFixed(2)}</span>}
          <span className={`border border-current/30 px-2 py-0.5 ${st[1]}`}>{st[0]}</span>
        </div>
      </div>
      <MarketChart history={history} entry={entry} stop={stop} tp={tp} />
    </section>
  );
}

/* ---------- protection form ---------- */
function ProtectionForm({ busy, run, client, hasEr }: any) {
  const [kind, setKind] = useState<"protect" | "entry">("protect");
  const [keeperBounty, setBounty] = useState(0);
  const [volScaled, setVol] = useState(false);
  const [ladder, setLadder] = useState<[number, number, number]>([0, 0, 0]);
  const [expiryMin, setExpiryMin] = useState(0);
  const [bracketStop, setBracketStop] = useState(0);
  const [settleDelay, setSettleDelay] = useState(0);
  const [f, setF] = useState<ProtectParams>({
    rule: "stop", addMargin: false, entry: 100, triggerPrice: 95, tpPrice: 0,
    trailDistance: 0, breakevenOffset: 0, marginAmount: 5, sizeUsd: 100, collateralUsd: 10,
  });
  const set = (k: keyof ProtectParams, v: any) => setF((p) => ({ ...p, [k]: v }));
  const params = () => ({ ...f, keeperBounty, volK: volScaled ? 300 : 0, tpLadder: ladder, expiry: expiryMin > 0 ? Math.floor(Date.now() / 1000) + expiryMin * 60 : 0, bracketStop: kind === "entry" ? bracketStop : 0, settleDelay });
  // Multi-position: pick the next free guard_id so a vault can hold many guards.
  const submit = async () => { const id = await client.nextGuardId(); return kind === "entry" ? client.placeLimitOrder(params(), id) : client.openAndProtect(params(), id); };
  const dp = (to: number) => (f.entry > 0 ? ((to - f.entry) / f.entry) * 100 : 0);
  const summary =
    f.rule === "takeProfit" ? `Auto-close if price rises to $${f.triggerPrice} (${dp(f.triggerPrice).toFixed(1)}% from entry).`
    : f.rule === "trailing" ? `Trail the stop $${f.trailDistance} below the peak; auto-close on a reversal${f.tpPrice > 0 ? ` or at $${f.tpPrice}` : ""}.`
    : `Auto-${f.addMargin ? "add margin" : "close"} if price falls to $${f.triggerPrice} (${dp(f.triggerPrice).toFixed(1)}% from entry)${f.tpPrice > 0 ? `, or take profit at $${f.tpPrice} (+${dp(f.tpPrice).toFixed(1)}%)` : ""}.`;
  const warn =
    f.entry <= 0 ? "Enter an entry price."
    : (f.rule === "stop" || f.rule === "trailing") && f.triggerPrice >= f.entry ? "Stop should be below entry for a long position."
    : f.rule === "takeProfit" && f.triggerPrice <= f.entry ? "Target should be above entry."
    : f.tpPrice > 0 && f.tpPrice <= f.entry ? "Take-profit should be above entry."
    : f.rule === "trailing" && f.trailDistance <= 0 ? "Set a trail distance for a trailing stop."
    : "";
  const disabled = !!busy || !client;

  return (
    <section className="p-6 md:p-7">
      <SectionLabel n="01">{kind === "entry" ? "Place a limit order" : "Protect a position"}</SectionLabel>
      <p className="text-[13px] text-white/50 mb-5 -mt-3">
        {kind === "entry" ? "Arm an on-chain order; the rollup opens it when price crosses your level." : "Open a vault-owned position and arm an on-chain guard in one step."}
      </p>

      <div className="grid grid-cols-2 border border-white/15 mb-5">
        {(["protect", "entry"] as const).map((k, i) => (
          <button key={k} onClick={() => setKind(k)}
            className={`anim h-10 text-sm ${i > 0 ? "border-l border-white/15" : ""} ${kind === k ? "bg-white text-black font-semibold" : "text-white/55 hover:text-white"}`}>
            {k === "protect" ? "Protect / Exit" : "Limit entry"}
          </button>
        ))}
      </div>

      <Label>{kind === "entry" ? "Entry trigger type" : "Protection type"}</Label>
      <div className="grid grid-cols-3 border border-white/15 mb-5">
        {RULES.map((r, i) => (
          <button key={r.key} onClick={() => set("rule", r.key)}
            className={`anim h-10 text-sm ${i > 0 ? "border-l border-white/15" : ""} ${f.rule === r.key ? "bg-white text-black font-semibold" : "text-white/55 hover:text-white"}`}>{r.label}</button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Money label="Entry price" v={f.entry} on={(n) => set("entry", n)} />
        <Money label={f.rule === "takeProfit" ? "Target price" : "Stop price"} v={f.triggerPrice} on={(n) => set("triggerPrice", n)} />
        {f.rule !== "takeProfit" && <Money label="Take-profit" v={f.tpPrice} on={(n) => set("tpPrice", n)} hint="0 = off" />}
        {f.rule === "trailing" && <Money label="Trail distance" v={f.trailDistance} on={(n) => set("trailDistance", n)} />}
        <Money label="Position size" v={f.sizeUsd} on={(n) => set("sizeUsd", n)} />
        <Money label="Collateral" v={f.collateralUsd} on={(n) => set("collateralUsd", n)} />
      </div>

      <label className="anim flex items-start gap-3 mt-5 p-3 border border-white/12 cursor-pointer hover:border-white/30">
        <input type="checkbox" checked={f.addMargin} onChange={(e) => set("addMargin", e.target.checked)} className="mt-0.5 accent-white h-4 w-4" />
        <span>
          <span className="text-sm font-medium flex items-center gap-1.5"><I.Lock size={14} /> Liquidation defense</span>
          <span className="block text-[12px] text-white/45 mt-0.5">Add margin to keep the position alive instead of closing it.</span>
        </span>
      </label>
      {f.addMargin && <div className="mt-4"><Money label="Margin to add on trigger" v={f.marginAmount} on={(n) => set("marginAmount", n)} /></div>}

      {/* keeper bounty + vol-scaled + ladder (advanced) */}
      <div className="grid grid-cols-2 gap-4 mt-4">
        <Money label="Keeper bounty (SOL)" v={keeperBounty} on={setBounty} hint="0 = none" />
        <Money label="Anti-MEV delay (s)" v={settleDelay} on={setSettleDelay} hint="0 = off" />
        {kind === "entry" && <Money label="Bracket stop on fill" v={bracketStop} on={setBracketStop} hint="0 = none" />}
        {kind === "protect" && <Money label="Time exit (min)" v={expiryMin} on={setExpiryMin} hint="0 = off" />}
        {kind === "protect" && f.rule !== "takeProfit" && <Money label="Breakeven offset" v={f.breakevenOffset} on={(n) => set("breakevenOffset", n)} hint="0 = off" />}
        {f.rule === "trailing" && kind === "protect" && (
          <label className="flex items-end gap-2 pb-2 text-[13px] text-white/70">
            <input type="checkbox" checked={volScaled} onChange={(e) => setVol(e.target.checked)} className="accent-white h-4 w-4" /> Volatility-scaled trail
          </label>
        )}
      </div>
      {kind === "protect" && (
        <div className="mt-4">
          <Label>Take-profit ladder (scale-out · 0 = off)</Label>
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <Money key={i} label={`Rung ${i + 1}`} v={ladder[i]} on={(n) => setLadder((l) => { const c = [...l] as [number, number, number]; c[i] = n; return c; })} />
            ))}
          </div>
        </div>
      )}

      {/* live preview */}
      <div className="mt-5 border border-white/12 p-3.5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-1.5">Preview</div>
        <p className="text-[13px] text-white/80 leading-relaxed">{summary}</p>
        {warn && <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warn"><I.Alert size={13} /> {warn}</p>}
      </div>

      <button disabled={disabled} onClick={run(kind === "entry" ? "Place order" : "Open & protect", submit)}
        className="anim w-full mt-6 h-12 bg-white text-black font-semibold tracking-wide disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:bg-white/90">
        {busy ? <><I.Spinner /> CONFIRMING…</> : <><I.Plus size={16} /> {kind === "entry" ? "PLACE LIMIT ORDER" : "OPEN & PROTECT"}</>}
      </button>
      <button disabled={disabled} onClick={run("Activate monitoring", () => client.activateMonitoring(0))}
        className="anim w-full mt-2 h-11 border border-white/25 text-white/80 hover:border-white/60 hover:text-white disabled:opacity-40 text-sm tracking-wide flex items-center justify-center gap-2">
        {busy === "Activate monitoring" ? <I.Spinner /> : <I.Bolt size={15} />} ACTIVATE MONITORING {!hasEr && <span className="text-white/35">· needs Devnet ER</span>}
      </button>
    </section>
  );
}

/* ---------- guards dashboard ---------- */
function GuardsPanel({ guards, hist, loadErr, busy, run, client, refresh }: any) {
  return (
    <section className="p-6 md:p-7 min-h-[20rem]">
      <div className="flex items-center justify-between mb-6">
        <SectionLabel n="02" tight>Your guards</SectionLabel>
        <button onClick={refresh} aria-label="Refresh guards" className="anim inline-flex items-center gap-1.5 text-xs text-white/45 hover:text-white"><I.Refresh size={14} /> Refresh</button>
      </div>

      {loadErr ? (
        <Emptyish icon={<I.Alert size={22} />} title="Couldn't load guards" body="The program may not be deployed on this network.">
          <button onClick={refresh} className="anim text-sm underline underline-offset-4 hover:text-white text-white/70">Try again</button>
        </Emptyish>
      ) : guards == null ? (
        <div className="space-y-px bg-white/10 border border-white/10">{[0, 1].map((i) => <div key={i} className="skel h-[104px] bg-black" />)}</div>
      ) : guards.length === 0 ? (
        <Emptyish icon={<I.Shield size={22} />} title="No guards yet" body="Arm your first protection with the form on the left — it will appear here, watched live by the rollup." />
      ) : (
        <div className="space-y-px bg-white/10 border border-white/10">{guards.map((g: any, i: number) => <GuardCard key={i} g={g} history={hist?.[g.pubkey.toBase58()] ?? []} busy={busy} run={run} client={client} />)}</div>
      )}
      {guards && guards.length > 0 && (
        <button disabled={!!busy} onClick={run("Withdraw vault", () => client.withdrawVault())}
          className="anim mt-4 w-full h-10 border border-white/15 text-white/70 hover:border-white/40 hover:text-white disabled:opacity-40 text-sm tracking-wide">
          Withdraw vault (non-custodial exit)
        </button>
      )}
    </section>
  );
}

/* ---------- grid / DCA bot tab ---------- */
function GridPanel({ client, busy, run }: any) {
  const [grids, setGrids] = useState<any[] | null>(null);
  const [g, setG] = useState({ lower: 90, upper: 110, levels: 5, sizeUsd: 10, mode: 0, interval: 2, entry: 100 });
  const set = (k: string, v: any) => setG((p) => ({ ...p, [k]: v }));
  const load = async () => { try { setGrids(await client.listGrids()); } catch { setGrids([]); } };
  useEffect(() => { if (client) load(); }, [client]);
  const create = run("Create bot", async () => { const id = (grids?.length ?? 0); await client.initGrid(id, g); await load(); });
  return (
    <div className="grid lg:grid-cols-5 gap-px bg-white/10 border border-white/10">
      <section className="lg:col-span-2 bg-black p-6 md:p-7">
        <SectionLabel n="01">Autonomous bot</SectionLabel>
        <p className="text-[13px] text-white/50 -mt-3 mb-5">The rollup crank runs the bot on-chain every tick — no server.</p>
        <div className="grid grid-cols-2 border border-white/15 mb-4">
          {[["Grid", 0], ["DCA", 1]].map(([l, m], i) => (
            <button key={l as string} onClick={() => set("mode", m)} className={`anim h-10 text-sm ${i > 0 ? "border-l border-white/15" : ""} ${g.mode === m ? "bg-white text-black font-semibold" : "text-white/55 hover:text-white"}`}>{l}</button>
          ))}
        </div>
        {g.mode === 0 ? (
          <div className="grid grid-cols-2 gap-4">
            <Money label="Range low" v={g.lower} on={(n) => set("lower", n)} />
            <Money label="Range high" v={g.upper} on={(n) => set("upper", n)} />
            <Num label="Grid levels" v={g.levels} on={(n) => set("levels", n)} />
            <Money label="Size / rung" v={g.sizeUsd} on={(n) => set("sizeUsd", n)} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Num label="Every N ticks" v={g.interval} on={(n) => set("interval", n)} />
            <Money label="Size / buy" v={g.sizeUsd} on={(n) => set("sizeUsd", n)} />
          </div>
        )}
        <button disabled={!!busy} onClick={create} className="anim w-full mt-6 h-12 bg-white text-black font-semibold tracking-wide disabled:opacity-40 flex items-center justify-center gap-2 hover:bg-white/90">
          {busy === "Create bot" ? <I.Spinner /> : <I.Bolt size={16} />} LAUNCH {g.mode === 0 ? "GRID" : "DCA"} BOT
        </button>
      </section>
      <section className="lg:col-span-3 bg-black p-6 md:p-7 min-h-[16rem]">
        <SectionLabel n="02" tight>Your bots</SectionLabel>
        <div className="mt-5 space-y-px bg-white/10 border border-white/10">
          {grids == null ? <div className="skel h-20 bg-black" /> : grids.length === 0 ? (
            <div className="bg-black"><Emptyish icon={<I.Layers size={22} />} title="No bots yet" body="Launch a grid or DCA bot — the crank runs it on-chain." /></div>
          ) : grids.map((gr: any, i: number) => (
            <div key={i} className="bg-black p-5 flex items-center justify-between">
              <div className="text-sm">
                <div className="font-medium flex items-center gap-2"><I.Layers size={15} className="text-white/50" /> {gr.mode === 1 ? "DCA bot" : "Grid bot"} <span className="font-mono text-white/30">#{Number(gr.gridId)}</span></div>
                <div className="font-mono text-[11px] text-white/45 mt-1">{gr.mode === 1 ? `every ${gr.intervalTicks} ticks` : `$${fromUnits(gr.lower).toFixed(0)}–$${fromUnits(gr.upper).toFixed(0)} · ${gr.levels} levels`} · {Number(gr.fills)} fills</div>
              </div>
              {gr.active && <button disabled={!!busy} onClick={run("Stop bot", () => client.stopGrid(gr.pubkey))} className="anim text-xs text-white/45 hover:text-danger">Stop</button>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ---------- copy-trading tab ---------- */
function CopyPanel({ client, busy, run }: any) {
  const [strats, setStrats] = useState<any[] | null>(null);
  const [s, setS] = useState({ stopOffset: 5, tpOffset: 10, trailDistance: 0, feeSol: 0 });
  const set = (k: string, v: any) => setS((p) => ({ ...p, [k]: v }));
  const load = async () => { try { setStrats(await client.listStrategies()); } catch { setStrats([]); } };
  useEffect(() => { if (client) load(); }, [client]);
  const publish = run("Publish strategy", async () => { const id = (strats?.filter((x: any) => x.leader.toBase58() === client.owner.toBase58()).length ?? 0); await client.publishStrategy(id, s); await load(); });
  const follow = (st: any) => run("Follow strategy", async () => { await client.followStrategy(st.leader, Number(st.strategyId), 100, await client.nextGuardId()); });
  return (
    <div className="grid lg:grid-cols-5 gap-px bg-white/10 border border-white/10">
      <section className="lg:col-span-2 bg-black p-6 md:p-7">
        <SectionLabel n="01">Publish a strategy</SectionLabel>
        <p className="text-[13px] text-white/50 -mt-3 mb-5">Share your guard template; followers' guards size to their own entry. Earn a follow fee.</p>
        <div className="grid grid-cols-2 gap-4">
          <Money label="Stop offset" v={s.stopOffset} on={(n) => set("stopOffset", n)} />
          <Money label="TP offset" v={s.tpOffset} on={(n) => set("tpOffset", n)} hint="0 = off" />
          <Money label="Trail distance" v={s.trailDistance} on={(n) => set("trailDistance", n)} hint="0 = off" />
          <Money label="Follow fee (SOL)" v={s.feeSol} on={(n) => set("feeSol", n)} hint="0 = free" />
        </div>
        <button disabled={!!busy} onClick={publish} className="anim w-full mt-6 h-12 bg-white text-black font-semibold tracking-wide disabled:opacity-40 flex items-center justify-center gap-2 hover:bg-white/90">
          {busy === "Publish strategy" ? <I.Spinner /> : <I.Plus size={16} />} PUBLISH STRATEGY
        </button>
      </section>
      <section className="lg:col-span-3 bg-black p-6 md:p-7 min-h-[16rem]">
        <SectionLabel n="02" tight>Leaderboard</SectionLabel>
        <div className="mt-5 space-y-px bg-white/10 border border-white/10">
          {strats == null ? <div className="skel h-20 bg-black" /> : strats.length === 0 ? (
            <div className="bg-black"><Emptyish icon={<I.Layers size={22} />} title="No strategies yet" body="Publish one — it'll appear here for others to copy." /></div>
          ) : [...strats].sort((a, b) => b.followers - a.followers).map((st: any, i: number) => (
            <div key={i} className="bg-black p-5 flex items-center justify-between">
              <div className="text-sm">
                <div className="font-medium flex items-center gap-2 font-mono">{trunc(st.leader.toBase58())} <span className="text-white/30">#{Number(st.strategyId)}</span></div>
                <div className="font-mono text-[11px] text-white/45 mt-1">stop −${fromUnits(st.stopOffset).toFixed(0)} · tp +${fromUnits(st.tpOffset).toFixed(0)} · {st.followers} followers · fee {(Number(st.feeLamports) / 1e9).toFixed(3)}◎</div>
              </div>
              <button disabled={!!busy} onClick={follow(st)} className="anim text-xs border border-white/20 hover:border-white/50 px-3 py-1.5">Copy</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ---------- portfolio drawdown tab ---------- */
function PortfolioPanel({ client, guards, busy, run }: any) {
  const [p, setP] = useState<any>(undefined);
  const [dd, setDd] = useState(20);
  const load = async () => { try { setP(await client.getPortfolio()); } catch { setP(null); } };
  useEffect(() => { if (client) load(); }, [client]);
  const set = run("Set drawdown guard", async () => { await client.initPortfolio(Math.round(dd * 100)); await load(); });
  return (
    <section className="border border-white/10 bg-black p-6 md:p-7 max-w-2xl">
      <SectionLabel n="01">Portfolio drawdown guard</SectionLabel>
      <p className="text-[13px] text-white/50 -mt-3 mb-5">Close every position automatically if aggregate equity falls more than your threshold from its high-water mark.</p>
      {p === undefined ? <div className="skel h-16 bg-black" /> : p ? (
        <div className="border border-white/12 p-4 font-mono text-[13px] text-white/70">
          Active · max drawdown {(p.maxDrawdownBps / 100).toFixed(0)}% · peak ${fromUnits(p.peakEquity).toFixed(2)} · {p.breached ? <span className="text-danger">BREACHED</span> : <span className="text-success">healthy</span>}
        </div>
      ) : (
        <div className="flex items-end gap-4">
          <div className="flex-1 max-w-[12rem]"><Num label="Max drawdown (%)" v={dd} on={setDd} /></div>
          <button disabled={!!busy} onClick={set} className="anim h-11 px-6 bg-white text-black font-semibold disabled:opacity-40">SET GUARD</button>
        </div>
      )}
      <p className="text-[12px] text-white/35 mt-4">Enforced permissionlessly by a keeper that passes your guards; the program trips them all if breached.</p>
    </section>
  );
}

function GuardCard({ g, history, busy, run, client }: any) {
  const status = g.executed ? { t: "Protected", c: "text-success border-success/40" }
    : g.triggered ? { t: "Firing", c: "text-warn border-warn/40" }
    : g.active ? { t: "Armed", c: "text-white border-white/30" }
    : { t: "Closed", c: "text-white/40 border-white/15" };
  const isEntry = !!g.kind?.entry;
  const rungs = (g.tpLadder ?? []).filter((x: any) => Number(x) > 0).length;
  const rule = isEntry ? "Limit entry" : rungs > 0 ? "TP ladder" : g.rule?.trailingStop ? "Trailing stop" : g.rule?.priceAbove ? "Take-profit" : "Stop-loss";
  const id = Number(g.guardId);
  const entry = fromUnits(g.entryPrice), stop = fromUnits(g.triggerPrice), last = fromUnits(g.lastPrice);
  const bounty = Number(g.keeperBounty) / 1e9;
  const buf = stopBuffer(g); // 1 = safe at entry, 0 = at stop
  const bufPct = Math.round(buf * 100);
  const barColor = buf < 0.15 ? "bg-danger" : buf < 0.35 ? "bg-warn" : "bg-success";
  const reason = g.tripReason === 2 ? "take-profit" : g.tripReason === 3 ? "time exit" : "stop-loss";

  return (
    <div className="anim bg-black p-5 hover:bg-white/[0.025]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <I.Shield size={15} className="text-white/50" /> {rule}
          <span className={`font-mono text-[10px] tracking-wide border px-1.5 py-0.5 ${g.side === 2 ? "text-danger border-danger/30" : "text-success border-success/30"}`}>{sideLabel(g.side)}</span>
          {g.action?.addMargin && <span className="font-mono text-[10px] text-warn border border-warn/30 px-1.5 py-0.5 tracking-wide">LIQ-DEFENSE</span>}
          {bounty > 0 && <span className="font-mono text-[10px] text-white/50 border border-white/20 px-1.5 py-0.5 tracking-wide">⛏ {bounty.toFixed(3)}◎</span>}
          <span className="font-mono text-white/30">#{id}</span>
        </div>
        <div className="flex items-center gap-3">
          {history?.length > 1 && <Sparkline history={history} up={last >= entry} />}
          <span className={`font-mono text-[10px] uppercase tracking-widest border px-2 py-0.5 ${status.c}`}>
            {g.executed && <I.Check size={10} className="inline mb-0.5 mr-1" />}{status.t}
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-3">
        <Cell label="Entry" v={`$${entry.toFixed(2)}`} />
        <Cell label="Stop" v={`$${stop.toFixed(2)}`} sub={`${pct(entry, stop).toFixed(1)}%`} />
        <Cell label="Take-profit" v={Number(g.tpPrice) > 0 ? `$${fromUnits(g.tpPrice).toFixed(2)}` : "—"} />
        <Cell label="Last" v={`$${last.toFixed(2)}`} sub={last ? `${pct(entry, last).toFixed(1)}%` : undefined} />
      </div>

      {/* live stop-buffer gauge (plain stops only) */}
      {!g.executed && !isEntry && rungs === 0 && isStopType(g) && (
        <div className="mt-4">
          <div className="flex justify-between font-mono text-[10px] uppercase tracking-widest text-white/40 mb-1.5">
            <span>Stop buffer</span><span className={buf < 0.35 ? "text-warn" : "text-white/60"}>{bufPct}%</span>
          </div>
          <div className="h-1.5 w-full bg-white/10 overflow-hidden">
            <div className={`h-full ${barColor} anim`} style={{ width: `${Math.max(2, bufPct)}%` }} />
          </div>
          <div className="flex justify-between font-mono text-[10px] text-white/30 mt-1"><span>stop ${stop.toFixed(2)}</span><span>entry ${entry.toFixed(2)}</span></div>
        </div>
      )}
      {isEntry && !g.executed && <div className="mt-4 font-mono text-[11px] text-white/55">⏳ Pending fill — opens when price crosses ${stop.toFixed(2)}.</div>}
      {rungs > 0 && !g.executed && <div className="mt-4 font-mono text-[11px] text-white/55">Ladder: {Number(g.ladderDone)}/{rungs} rungs closed.</div>}
      {g.executed && <div className="mt-4 font-mono text-[11px] text-success">✓ {isEntry ? "Entry filled" : `Auto-protected via ${reason}`}.</div>}

      {g.active && (
        <div className="mt-4 flex justify-end">
          <button disabled={!!busy} onClick={run("Cancel guard", () => client.cancelGuard(id))}
            className="anim inline-flex items-center gap-1.5 text-xs text-white/45 hover:text-danger disabled:opacity-50"><I.Trash size={13} /> Cancel</button>
        </div>
      )}
    </div>
  );
}
const Cell = ({ label, v, sub }: any) => (
  <div>
    <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">{label}</div>
    <div className="font-mono tnum mt-1 text-sm">{v}</div>
    {sub && <div className="font-mono tnum text-[10px] text-white/35">{sub}</div>}
  </div>
);

/* ---------- shared ---------- */
const SectionLabel = ({ n, children, tight }: any) => (
  <div className={tight ? "" : "mb-5"}><span className="font-mono text-[11px] tracking-widest text-white/40 uppercase">[{n}]</span> <span className="text-base font-semibold">{children}</span></div>
);
const Label = ({ children }: any) => <div className="font-mono text-[11px] uppercase tracking-widest text-white/45 mb-2">{children}</div>;
function Money({ label, v, on, hint }: { label: string; v: number; on: (n: number) => void; hint?: string }) {
  return (
    <label className="block">
      <span className="font-mono text-[11px] uppercase tracking-widest text-white/45 flex items-center justify-between"><span>{label}</span>{hint && <span className="text-white/30 normal-case tracking-normal">{hint}</span>}</span>
      <span className="mt-1.5 flex items-center border border-white/15 focus-within:border-white/60 anim">
        <span className="pl-3 text-white/35 text-sm">$</span>
        <input type="number" inputMode="decimal" value={v} onChange={(e) => on(parseFloat(e.target.value) || 0)}
          className="w-full bg-transparent px-2 py-2.5 text-sm font-mono tnum outline-none" />
      </span>
    </label>
  );
}
function Num({ label, v, on }: { label: string; v: number; on: (n: number) => void }) {
  return (
    <label className="block">
      <span className="font-mono text-[11px] uppercase tracking-widest text-white/45">{label}</span>
      <input type="number" inputMode="numeric" value={v} onChange={(e) => on(parseFloat(e.target.value) || 0)}
        className="mt-1.5 w-full bg-transparent border border-white/15 focus:border-white/60 anim px-3 py-2.5 text-sm font-mono tnum outline-none" />
    </label>
  );
}
function Emptyish({ icon, title, body, children }: any) {
  return (
    <div className="text-center py-14 px-4 border border-white/10">
      <span className="grid place-items-center h-12 w-12 mx-auto border border-white/15 text-white/50 mb-4">{icon}</span>
      <div className="font-medium">{title}</div>
      <p className="text-[13px] text-white/50 mt-1.5 max-w-xs mx-auto leading-relaxed">{body}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
function Toast({ toast, onClose }: { toast: { kind: "ok" | "err"; msg: string }; onClose: () => void }) {
  const ok = toast.kind === "ok";
  return (
    <div role="status" className="rise fixed bottom-6 right-6 z-40 max-w-sm flex items-start gap-3 bg-black border px-4 py-3"
      style={{ borderColor: ok ? "#22c55e66" : "#f8717166" }}>
      <span className={ok ? "text-success" : "text-danger"}>{ok ? <I.Check size={18} /> : <I.Alert size={18} />}</span>
      <p className="text-sm flex-1 break-words">{toast.msg}</p>
      <button onClick={onClose} aria-label="Dismiss" className="text-white/40 hover:text-white anim p-1 -m-1">✕</button>
    </div>
  );
}
function Analytics({ guards }: any) {
  const list = guards ?? [];
  const protectedN = list.filter((g: any) => g.executed).length;
  const active = list.filter((g: any) => g.active).length;
  const sizeGuarded = list.filter((g: any) => g.active).reduce((s: number, g: any) => s + fromUnits(g.entrySize), 0);
  const bounties = list.reduce((s: number, g: any) => s + Number(g.keeperBounty) / 1e9, 0);
  return (
    <section className="border border-white/10 bg-black p-6 md:p-7">
      <SectionLabel n="03" tight>Analytics</SectionLabel>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/10 border border-white/10 mt-4">
        <Metric label="Positions protected" v={guards == null ? "—" : protectedN} />
        <Metric label="Active guards" v={guards == null ? "—" : active} />
        <Metric label="Size guarded" v={guards == null ? "—" : `$${sizeGuarded.toFixed(0)}`} />
        <Metric label="Keeper bounties" v={guards == null ? "—" : `${bounties.toFixed(3)} ◎`} />
      </div>
    </section>
  );
}
const Metric = ({ label, v }: any) => (
  <div className="bg-black p-5">
    <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">{label}</div>
    <div className="font-mono tnum text-2xl mt-1.5">{v}</div>
  </div>
);

function Footer({ cluster }: { cluster: ClusterKey }) {
  return (
    <footer className="border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6 md:px-10 lg:px-14 py-5 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] tracking-widest text-white/35 uppercase">
        <span>Monitoring runs on-chain — no server, non-custodial.</span>
        <span>Sentinel · {CLUSTERS[cluster].label}</span>
      </div>
    </footer>
  );
}
