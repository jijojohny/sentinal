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

export type Guard = {
  entryPrice: number;
  triggerPrice: number;
  tpPrice: number;
  lastPrice: number;
  triggered: boolean;
  executed: boolean;
  active: boolean;
  tripReason: number; // 0 none, 1 stop, 2 take-profit, 3 time
};
export function decodeGuard(data: Uint8Array | null): Guard | null {
  // GuardConfig v2 layout (after 8-byte disc):
  // vault@8 owner@40 market@72 guard_id@104 side@112 rule@113 action@114
  // entry@115 trigger@123 trail@131 tp@139 breakeven_off@147 expiry@155
  // margin@163 close_limit@171 last@179 high@187 triggered@195 executed@196
  // active@197 breakeven_armed@198 trip_reason@199 bump@200
  if (!data || data.length < 201) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    entryPrice: u64(dv, 115),
    triggerPrice: u64(dv, 123),
    tpPrice: u64(dv, 139),
    lastPrice: u64(dv, 179),
    triggered: data[195] === 1,
    executed: data[196] === 1,
    active: data[197] === 1,
    tripReason: data[199],
  };
}

// A position is "open" iff its account exists (execute_protection closes it).
export function positionOpen(data: Uint8Array | null): boolean {
  return !!data && data.length > 8;
}

export const usd = (n: number) => `$${(n / 1e6).toFixed(2)}`;
