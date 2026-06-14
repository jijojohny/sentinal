import React, { useEffect, useState } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import * as I from "./icons";

const NAV = [
  { label: "How it works", href: "#how" },
  { label: "Order types", href: "#orders" },
  { label: "Security", href: "#security" },
  { label: "The rollup", href: "#rollup" },
];

export default function Landing({ onLaunch }: { onLaunch: () => void }) {
  const { setVisible } = useWalletModal();
  const { publicKey } = useWallet();
  // Always advance past the landing; only pop the wallet modal if not already connected
  // (autoConnect may have silently reconnected a returning visitor).
  const launch = () => { onLaunch(); if (!publicKey) setVisible(true); };
  const [clock, setClock] = useState(timeStr());
  useEffect(() => { const t = setInterval(() => setClock(timeStr()), 1000); return () => clearInterval(t); }, []);

  // Reveal sections as they scroll into view (no-op effect for reduced-motion users —
  // the .reveal hidden state only exists inside the no-preference media query).
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }),
      { threshold: 0.15 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-white selection:text-black">
      {/* ===== hero screen ===== */}
      <section className="relative min-h-screen flex flex-col px-6 md:px-10 lg:px-14 pt-7 pb-8 overflow-hidden">
        <BgArt />

        {/* header */}
        <div className="relative z-10 flex items-start justify-between gap-6 a-up">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2.5">
              <span className="grid place-items-center h-9 w-9 rounded-md border border-white/20"><I.Shield size={18} /></span>
              <span className="text-xl font-bold tracking-[0.18em]">SENTINEL</span>
            </div>
            <div className="hidden md:block font-mono text-[10px] leading-tight tracking-widest text-white/45 uppercase">
              Non-custodial<br />trading guardian
            </div>
            <div className="hidden lg:block font-mono text-[10px] tracking-widest text-white/30">[019.ER]</div>
            <span className="hidden lg:grid place-items-center h-7 w-7 text-white/40" style={{ animation: "spin 9s linear infinite" }}><I.Refresh size={16} /></span>
          </div>
          <div className="text-right font-mono text-[10px] leading-relaxed tracking-widest text-white/45 tnum uppercase">
            <div className="text-white/70">{clock}</div>
            <div>Watching…</div>
            <div>Watching…</div>
            <div>2026 Sentinel</div>
          </div>
        </div>
        <div className="relative z-10 mt-5 h-px w-full bg-white/15 a-line" />

        {/* right vertical nav */}
        <nav className="absolute z-10 right-6 md:right-10 lg:right-14 top-40 w-44 hidden md:block">
          {NAV.map((n, i) => (
            <a key={n.href} href={n.href} style={{ animationDelay: `${0.55 + i * 0.07}s` }}
              className="block border-t border-white/12 py-4 text-[15px] text-white/85 hover:text-white hover:pl-1 anim a-up">{n.label}</a>
          ))}
          <button onClick={launch} style={{ animationDelay: `${0.55 + NAV.length * 0.07}s` }} className="w-full text-left border-t border-white/12 py-4 text-[15px] text-white hover:text-white anim a-up flex items-center justify-between group">
            Launch app <span className="anim group-hover:translate-x-1">→</span>
          </button>
          <WaitlistMini />
        </nav>

        {/* hero copy (bottom-left) */}
        <div className="relative z-10 mt-auto max-w-3xl">
          <h1 className="font-bold tracking-tight leading-[0.95] text-[clamp(2.6rem,7vw,6rem)]">
            <span className="block overflow-hidden"><span className="block a-rise" style={{ animationDelay: ".3s" }}>Autonomous protection</span></span>
            <span className="block overflow-hidden"><span className="block a-rise" style={{ animationDelay: ".42s" }}>for on-chain positions.</span></span>
          </h1>
          <p className="mt-6 max-w-xl text-white/65 text-base md:text-lg leading-relaxed a-up" style={{ animationDelay: ".7s" }}>
            Sentinel arms a guard on your perp position and lets a MagicBlock Ephemeral Rollup watch it
            every tick — auto-closing or defending it the moment your rule trips. No keeper server, no
            custody. Your keys, your vault, the chain as your watchman.
          </p>
          <button onClick={launch} style={{ animationDelay: ".82s" }}
            className="mt-8 anim a-up inline-flex items-center gap-2 rounded-full border border-white/80 px-6 h-12 text-sm font-semibold tracking-wide hover:bg-white hover:text-black">
            LAUNCH APP <span>→</span>
          </button>
        </div>

        {/* footer row */}
        <div className="relative z-10 mt-10 flex items-end justify-between text-white/40 a-up" style={{ animationDelay: "1s" }}>
          <div className="flex items-center gap-4">
            <a href="https://x.com" aria-label="X" className="hover:text-white anim text-xs font-mono tracking-widest">X</a>
            <a href="https://github.com" aria-label="GitHub" className="hover:text-white anim"><I.Copy size={15} /></a>
          </div>
          <div className="text-[11px] font-mono tracking-widest text-right text-white/35">© 2026 SENTINEL · NON-CUSTODIAL</div>
        </div>
      </section>

      {/* ===== content sections ===== */}
      <How />
      <Orders />
      <Security />
      <Rollup launch={launch} />

      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        html{scroll-behavior:smooth}
        @media (prefers-reduced-motion: no-preference){
          .a-up{opacity:0;transform:translateY(16px);animation:aUp .8s cubic-bezier(.16,1,.3,1) both}
          @keyframes aUp{to{opacity:1;transform:none}}
          .a-rise{transform:translateY(118%);animation:aRise .95s cubic-bezier(.16,1,.3,1) both}
          @keyframes aRise{to{transform:none}}
          .a-line{transform:scaleX(0);transform-origin:left;animation:aLine 1.1s cubic-bezier(.16,1,.3,1) .15s both}
          @keyframes aLine{to{transform:scaleX(1)}}
          .reveal{opacity:0;transform:translateY(28px);transition:opacity .8s cubic-bezier(.16,1,.3,1),transform .8s cubic-bezier(.16,1,.3,1)}
          .reveal.in{opacity:1;transform:none}
          .draw{stroke-dasharray:1600;stroke-dashoffset:1600;animation:draw 2.8s ease-out .5s forwards}
          @keyframes draw{to{stroke-dashoffset:0}}
          .floaty{animation:floaty 16s ease-in-out infinite}
          @keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}
        }
        @media (prefers-reduced-motion: reduce){ html{scroll-behavior:auto} [style*="spin"]{animation:none!important} }
      `}</style>
    </div>
  );
}

function WaitlistMini() {
  const [done, setDone] = useState(false);
  return (
    <div className="border-t border-white/12 pt-4 mt-1">
      <p className="text-[11px] text-white/45 leading-snug mb-2">Protection updates &amp; new venues.</p>
      {done ? (
        <p className="text-[11px] text-white/70 font-mono">Thanks — you're on the list.</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); setDone(true); }} className="flex items-center border-b border-white/20 focus-within:border-white anim">
          <input type="email" required placeholder="Your email" aria-label="Email"
            className="w-full bg-transparent py-1.5 text-[13px] outline-none placeholder:text-white/30" />
          <button aria-label="Subscribe" className="text-white/60 hover:text-white anim">→</button>
        </form>
      )}
    </div>
  );
}

/* ---- background line-art: a large shield + a stop-loss price line ---- */
function BgArt() {
  return (
    <svg className="floaty pointer-events-none absolute -right-20 top-1/3 w-[1100px] max-w-none opacity-[0.06]" viewBox="0 0 800 600" fill="none" stroke="white" aria-hidden="true">
      <path d="M400 70l250 110v150c0 160-110 270-250 330-140-60-250-170-250-330V180L400 70z" strokeWidth="2" />
      <path d="M400 130l190 84v118c0 122-84 206-190 252-106-46-190-130-190-252V214L400 130z" strokeWidth="1.5" opacity="0.7" />
      <polyline className="draw" points="120,300 240,300 300,250 360,330 420,210 480,360 560,260 680,420" strokeWidth="2.5" />
      <line x1="120" y1="360" x2="680" y2="360" strokeWidth="1" strokeDasharray="6 8" opacity="0.6" />
    </svg>
  );
}

/* ---- sections ---- */
function SectionLabel({ n, children }: any) {
  return <div className="font-mono text-[11px] tracking-widest text-white/40 uppercase mb-6">[{n}] {children}</div>;
}

function How() {
  const steps = [
    { t: "Open & protect", d: "Connect, open a vault-owned position, and set a rule — stop, take-profit, trailing, OCO, or liquidation defense." },
    { t: "The rollup watches", d: "A scheduled crank in the Ephemeral Rollup reads the price every tick and evaluates your rule — gaslessly, with no server." },
    { t: "Auto-settle", d: "The instant the rule trips, a permissionless on-chain transaction closes or defends the position. You never had to be online." },
  ];
  return (
    <section id="how" className="reveal border-t border-white/10 bg-black px-6 md:px-10 lg:px-14 py-20">
      <SectionLabel n="01">How it works</SectionLabel>
      <div className="grid md:grid-cols-3 gap-px bg-white/10 border border-white/10">
        {steps.map((s, i) => (
          <div key={i} className="bg-black p-7">
            <div className="font-mono text-white/30 text-sm mb-4">0{i + 1}</div>
            <h3 className="text-xl font-semibold mb-2">{s.t}</h3>
            <p className="text-white/55 text-[15px] leading-relaxed">{s.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Orders() {
  const items = [
    "Stop-loss", "Take-profit", "OCO bracket", "Trailing stop", "Breakeven", "Time exit",
    "Liquidation defense", "Multi-position", "Copy-trading", "Grid / DCA bot", "Session keys", "Pyth oracle",
  ];
  return (
    <section id="orders" className="reveal border-t border-white/10 bg-black px-6 md:px-10 lg:px-14 py-20">
      <SectionLabel n="02">Order types &amp; automation</SectionLabel>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-white/10 border border-white/10">
        {items.map((it) => (
          <div key={it} className="bg-black px-6 py-5 flex items-center gap-3 hover:bg-white/[0.03] anim">
            <I.Shield size={15} className="text-white/40" /><span className="text-[15px]">{it}</span>
          </div>
        ))}
      </div>
      <p className="text-white/45 text-sm mt-5 max-w-xl">Every rule is enforced by the on-chain crank — including trailing stops that ratchet up each tick and liquidation defense that adds margin to keep you alive.</p>
    </section>
  );
}

function Security() {
  return (
    <section id="security" className="reveal border-t border-white/10 bg-black px-6 md:px-10 lg:px-14 py-24">
      <SectionLabel n="03">Security</SectionLabel>
      <h2 className="text-3xl md:text-5xl font-bold tracking-tight leading-[1.05] max-w-3xl">
        Your vault owns the position. Sentinel can only run your rule — never move your funds.
      </h2>
      <div className="grid md:grid-cols-3 gap-8 mt-12 max-w-4xl">
        {[
          ["Non-custodial", "A data-less vault PDA holds your position. You can cancel or withdraw at any time."],
          ["No keeper server", "Monitoring runs on-chain in the rollup. There is no off-chain bot that can go down or rug."],
          ["Discretion-free settlement", "Anyone can poke the close, but the program is the sole authority — it only acts when your rule trips."],
        ].map(([t, d]) => (
          <div key={t}><div className="text-white font-medium mb-1.5">{t}</div><p className="text-white/55 text-sm leading-relaxed">{d}</p></div>
        ))}
      </div>
    </section>
  );
}

function Rollup({ launch }: { launch: () => void }) {
  return (
    <section id="rollup" className="reveal border-t border-white/10 bg-black px-6 md:px-10 lg:px-14 py-24 text-center">
      <SectionLabel n="04"><span className="block text-center">Built on MagicBlock Ephemeral Rollups</span></SectionLabel>
      <h2 className="text-3xl md:text-5xl font-bold tracking-tight max-w-3xl mx-auto leading-[1.05]">Protection that watches you 24/7 — without watching over your funds.</h2>
      <button onClick={launch} className="mt-10 anim inline-flex items-center gap-2 rounded-full border border-white/80 px-7 h-12 text-sm font-semibold tracking-wide hover:bg-white hover:text-black">
        LAUNCH APP <span>→</span>
      </button>
      <div className="mt-16 text-[11px] font-mono tracking-widest text-white/30">© 2026 SENTINEL · NON-CUSTODIAL ON-CHAIN GUARDIAN</div>
    </section>
  );
}

const timeStr = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).toUpperCase();
