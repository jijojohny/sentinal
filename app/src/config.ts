import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// The featured Sentinel program + the venue (flash_stub interface harness).
export const SENTINEL_PROGRAM_ID = new PublicKey("DhQechQHWUwhtDfVCDa5oBjjeq955iB8YMNrH5TrTBPF");
export const VENUE_PROGRAM_ID = new PublicKey("3pueX18BCYp8D2qNbdTrDeLDhP25uuEHe7HG2DCfqd8F");

export type ClusterKey = "local" | "devnet";
export const CLUSTERS: Record<ClusterKey, { label: string; rpc: string; er: string }> = {
  local: { label: "Localnet", rpc: "http://127.0.0.1:8899", er: "" },
  devnet: { label: "Devnet + MagicBlock ER", rpc: "https://api.devnet.solana.com", er: "https://devnet-as.magicblock.app/" },
};

const enc = new TextEncoder();
const seed = (s: string) => enc.encode(s);
export const gidBuf = (id: number | BN) => new BN(id).toArrayLike(Buffer, "le", 8);

export function vaultPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([seed("vault"), owner.toBuffer()], SENTINEL_PROGRAM_ID)[0];
}
export function guardPda(vault: PublicKey, guardId: number | BN) {
  return PublicKey.findProgramAddressSync([seed("guard"), vault.toBuffer(), gidBuf(guardId)], SENTINEL_PROGRAM_ID)[0];
}
export function pricePda(vault: PublicKey, guardId: number | BN) {
  return PublicKey.findProgramAddressSync([seed("price"), vault.toBuffer(), gidBuf(guardId)], SENTINEL_PROGRAM_ID)[0];
}
export function positionPda(vault: PublicKey) {
  return PublicKey.findProgramAddressSync([seed("position"), vault.toBuffer()], VENUE_PROGRAM_ID)[0];
}
export function strategyPda(leader: PublicKey, id: number | BN) {
  return PublicKey.findProgramAddressSync([seed("strategy"), leader.toBuffer(), gidBuf(id)], SENTINEL_PROGRAM_ID)[0];
}
export function gridPda(vault: PublicKey, id: number | BN) {
  return PublicKey.findProgramAddressSync([seed("grid"), vault.toBuffer(), gidBuf(id)], SENTINEL_PROGRAM_ID)[0];
}
export function gridFeedPda(grid: PublicKey) {
  return PublicKey.findProgramAddressSync([seed("price"), grid.toBuffer()], SENTINEL_PROGRAM_ID)[0];
}
export function portfolioPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([seed("portfolio"), owner.toBuffer()], SENTINEL_PROGRAM_ID)[0];
}

// Rule + action variants as Anchor enum objects.
export const RULES = {
  stop: { priceBelow: {} },
  takeProfit: { priceAbove: {} },
  trailing: { trailingStop: {} },
} as const;
export const ACTIONS = { close: { close: {} }, addMargin: { addMargin: {} } } as const;

export const USD = 1_000_000; // 1e6 oracle units
export const toUnits = (n: number) => new BN(Math.round(n * USD));
export const fromUnits = (n: BN | number) => Number(n) / USD;
