/**
 * Sentinel notifier — off-chain alert service.
 *
 * Polls all GuardConfig accounts and fires a webhook/Telegram message the moment a
 * guard flips `triggered` or `executed`. The on-chain crank does the work; this just
 * watches and tells the trader. Stateless and replaceable — anyone can run it.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
 *     WEBHOOK_URL=https://hooks.slack.com/... \
 *     npx ts-mocha -p ./tsconfig.json -t 0 scripts/notifier.ts   # or compile + node
 *
 * Telegram: set TELEGRAM_TOKEN + TELEGRAM_CHAT instead of WEBHOOK_URL.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";

const WEBHOOK = process.env.WEBHOOK_URL;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT;

async function notify(text: string) {
  console.log("🔔", text);
  try {
    if (WEBHOOK) await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (TG_TOKEN && TG_CHAT)
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text }),
      });
  } catch (e) { console.error("notify failed", e); }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Sentinel as Program<Sentinel>;
  const seen = new Map<string, string>(); // pubkey → last state
  console.log("Sentinel notifier watching guards…");
  for (;;) {
    try {
      const guards = await program.account.guardConfig.all();
      for (const g of guards) {
        const k = g.publicKey.toBase58();
        const a: any = g.account;
        const state = a.executed ? "executed" : a.triggered ? "triggered" : "armed";
        const prev = seen.get(k);
        if (prev && prev !== state) {
          const rule = a.rule?.trailingStop ? "trailing stop" : a.rule?.priceAbove ? "take-profit" : "stop-loss";
          if (state === "triggered") await notify(`⚡ Guard #${Number(a.guardId)} (${rule}) TRIPPED at $${(Number(a.lastPrice) / 1e6).toFixed(2)} — settling.`);
          if (state === "executed") await notify(`✅ Guard #${Number(a.guardId)} protected your position. Non-custodial, no server.`);
        }
        seen.set(k, state);
      }
    } catch (e) { console.error(e); }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
main();
