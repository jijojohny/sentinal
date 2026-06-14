import React, { useId } from "react";

type ChartProps = { history: number[]; entry: number; stop: number; tp: number; height?: number };

/** Live price chart with entry / stop / take-profit reference lines + a pinging
 *  last-price dot. Pure SVG — fed by the dashboard's poll history. */
export function MarketChart({ history, entry, stop, tp, height = 240 }: ChartProps) {
  const gid = useId().replace(/:/g, "");
  const W = 820, H = height, padX = 14, padTop = 16, padBot = 26;
  const data = history.length ? history : [entry, entry];
  const levels = [entry, stop, tp].filter((x) => x > 0);
  const lo = Math.min(...data, ...levels);
  const hi = Math.max(...data, ...levels);
  const range = hi - lo || hi || 1;
  const bot = lo - range * 0.12, top = hi + range * 0.12, span = top - bot || 1;
  const x = (i: number) => padX + (i / Math.max(1, data.length - 1)) * (W - 2 * padX);
  const y = (p: number) => padTop + (1 - (p - bot) / span) * (H - padTop - padBot);

  const linePts = data.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const areaPath = `M ${x(0)},${y(data[0])} L ${linePts} L ${x(data.length - 1)},${H - padBot} L ${x(0)},${H - padBot} Z`;
  const last = data[data.length - 1];
  const up = last >= entry;
  const lineColor = up ? "#22c55e" : "#f87171";

  const Level = ({ v, color, label }: { v: number; color: string; label: string }) =>
    v > 0 ? (
      <g>
        <line x1={padX} x2={W - padX} y1={y(v)} y2={y(v)} stroke={color} strokeWidth="1" strokeDasharray="3 6" opacity="0.5" />
        <text x={W - padX} y={y(v) - 4} textAnchor="end" fontSize="10" fill={color} opacity="0.9"
          style={{ fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.08em" }}>{label} ${v.toFixed(2)}</text>
      </g>
    ) : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* horizontal gridlines */}
      {[0.25, 0.5, 0.75].map((t) => (
        <line key={t} x1={padX} x2={W - padX} y1={padTop + t * (H - padTop - padBot)} y2={padTop + t * (H - padTop - padBot)} stroke="#ffffff" strokeWidth="0.5" opacity="0.05" />
      ))}
      <Level v={tp} color="#22c55e" label="TP" />
      <Level v={entry} color="#ffffff" label="ENTRY" />
      <Level v={stop} color="#f87171" label="STOP" />
      <path d={areaPath} fill={`url(#g${gid})`} />
      <polyline points={linePts} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {/* live last-price dot with ping */}
      <circle cx={x(data.length - 1)} cy={y(last)} r="3.5" fill={lineColor} />
      <circle cx={x(data.length - 1)} cy={y(last)} r="3.5" fill="none" stroke={lineColor} strokeWidth="1.5">
        <animate attributeName="r" from="3.5" to="13" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" from="0.6" to="0" dur="1.8s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

/** Tiny inline sparkline for guard cards. */
export function Sparkline({ history, up }: { history: number[]; up: boolean }) {
  const data = history.length > 1 ? history : [0, 0];
  const W = 120, H = 28;
  const lo = Math.min(...data), hi = Math.max(...data), span = hi - lo || 1;
  const pts = data.map((p, i) => `${(i / (data.length - 1)) * W},${H - ((p - lo) / span) * (H - 4) - 2}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? "#22c55e" : "#f87171"} strokeWidth="1.5" strokeLinejoin="round" opacity="0.85" />
    </svg>
  );
}
