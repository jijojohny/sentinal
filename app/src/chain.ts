// Minimal, dependency-free on-chain reader: raw JSON-RPC getAccountInfo + manual
// borsh decode. No web3.js/anchor/Buffer in the browser — robust for the demo.

export async function fetchAccountData(rpc: string, pubkey: string): Promise<Uint8Array | null> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkey, { encoding: "base64", commitment: "processed" }],
    }),
  });
  const json = await res.json();
  const val = json?.result?.value;
  if (!val) return null;
  const b64 = val.data[0];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const u64 = (dv: DataView, off: number) => Number(dv.getBigUint64(off, true));

export type PriceFeed = { price: number };
export function decodePriceFeed(data: Uint8Array | null): PriceFeed | null {
  if (!data || data.length < 48) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // disc(8) + market(32) + price(u64)
  return { price: u64(dv, 40) };
}

export type Guard = { lastPrice: number; triggerPrice: number; triggered: boolean; executed: boolean; active: boolean };
export function decodeGuard(data: Uint8Array | null): Guard | null {
  if (!data || data.length < 134) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // disc8, vault32, owner32, market32, side1, rule1, trigger_price@106, close@114, last@122, triggered@130, executed131, active132
  return {
    triggerPrice: u64(dv, 106),
    lastPrice: u64(dv, 122),
    triggered: data[130] === 1,
    executed: data[131] === 1,
    active: data[132] === 1,
  };
}

// A position is "open" iff its account exists (execute_protection closes it).
export function positionOpen(data: Uint8Array | null): boolean {
  return !!data && data.length > 8;
}

export const usd = (n: number) => `$${(n / 1e6).toFixed(2)}`;
