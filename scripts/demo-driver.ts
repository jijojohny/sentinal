/**
 * Sentinel demo driver. Runs the full guardian flow on the LOCAL validator,
 * pacing the price decline so the web UI (app/) can animate it. Writes the PDAs
 * to app/src/demo-config.json so the read-only UI knows what to poll.
 *
 * Run (validator + programs already deployed locally):
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
 *     npx ts-mocha -p ./tsconfig.json -t 600000 scripts/demo-driver.ts
 *
 * On local there is no ER, so we call `evaluate` directly (one crank tick); the
 * autonomous crank is proven separately on devnet (tests/sentinel-er-flow.ts).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { FlashStub } from "../target/types/flash_stub";
import { writeFileSync } from "fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry transient RPC errors (e.g. "Blockhash not found" on a busy local validator).
async function R<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(700);
    }
  }
  throw last;
}

describe("demo-driver", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const venue = anchor.workspace.FlashStub as Program<FlashStub>;

  const traderKp = web3.Keypair.generate();
  const trader = traderKp.publicKey;
  const pda = (seeds: (Buffer | Uint8Array)[], pid: web3.PublicKey) => web3.PublicKey.findProgramAddressSync(seeds, pid)[0];
  const vault = pda([Buffer.from("vault"), trader.toBuffer()], sentinel.programId);
  const guard = pda([Buffer.from("guard"), vault.toBuffer()], sentinel.programId);
  const price = pda([Buffer.from("price"), vault.toBuffer()], sentinel.programId);
  const position = pda([Buffer.from("position"), vault.toBuffer()], venue.programId);

  const market = web3.Keypair.generate().publicKey;
  const dummy = web3.Keypair.generate().publicKey;
  const sysId = web3.SystemProgram.programId;
  const ENTRY = 100_000_000, STOP = 95_000_000, LIQ = 90_000_000;
  const mt = (pk: web3.PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });
  const openRem = () => [mt(dummy, true), mt(dummy, false), mt(dummy, false), mt(market, true), mt(position, true), mt(dummy, true), mt(dummy, false), mt(dummy, true), mt(dummy, false), mt(dummy, true), mt(sysId, false), mt(sysId, false)];
  const closeRem = () => [mt(dummy, true), mt(dummy, false), mt(dummy, false), mt(market, true), mt(position, true), mt(dummy, true), mt(dummy, false), mt(dummy, true), mt(dummy, false), mt(dummy, true), mt(sysId, false)];

  it("runs the demo flow", async () => {
    writeFileSync(
      "app/src/demo-config.json",
      JSON.stringify(
        {
          rpc: provider.connection.rpcEndpoint,
          explorerCluster: "custom&customUrl=" + encodeURIComponent(provider.connection.rpcEndpoint),
          sentinelProgram: sentinel.programId.toBase58(),
          venueProgram: venue.programId.toBase58(),
          trader: trader.toBase58(),
          vault: vault.toBase58(),
          guard: guard.toBase58(),
          priceFeed: price.toBase58(),
          position: position.toBase58(),
          entryPrice: ENTRY,
          stopPrice: STOP,
          liqPrice: LIQ,
        },
        null,
        2,
      ),
    );
    console.log("   wrote app/src/demo-config.json — start the UI and watch");

    // Fund the fresh trader + the data-less vault PDA.
    await provider.sendAndConfirm(
      new web3.Transaction()
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: trader, lamports: 0.5 * web3.LAMPORTS_PER_SOL }))
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vault, lamports: 0.05 * web3.LAMPORTS_PER_SOL })),
      [],
      { commitment: "confirmed" },
    );
    await sleep(2000);

    // 1) Vault opens a Flash-interface position via CPI.
    await R(() =>
      sentinel.methods
        .openProtectedPosition({ price: new BN(ENTRY), collateral: new BN(10_000_000), size: new BN(100_000_000), side: 1 })
        .accounts({ vault, owner: trader, flashProgram: venue.programId, trader })
        .remainingAccounts(openRem())
        .signers([traderKp])
        .rpc({ commitment: "confirmed" }),
    );
    console.log("   position opened");
    await sleep(1500);

    // 2) Register the guard (stop @ $95).
    await R(() =>
      sentinel.methods
        .registerGuard({ market, side: 1, rule: { priceBelow: {} }, triggerPrice: new BN(STOP), trailDistance: new BN(0), closePriceLimit: new BN(94_000_000), initialPrice: new BN(ENTRY) })
        .accounts({ vault, guard, priceFeed: price, trader })
        .signers([traderKp])
        .rpc({ commitment: "confirmed" }),
    );
    console.log("   guard armed");
    await sleep(1500);

    // 3) Crash the price. The guarded position auto-closes at the stop ($95) mid-crash;
    //    the price keeps falling below liquidation ($90) so the UNPROTECTED side dies —
    //    the dramatic side-by-side contrast.
    const ticks = [99_400_000, 98_500_000, 97_300_000, 96_400_000, 95_600_000, 94_800_000, 93_000_000, 91_000_000, 89_000_000, 87_500_000];
    let closed = false;
    for (const p of ticks) {
      await R(() => sentinel.methods.pushPrice(new BN(p), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: price }).rpc({ commitment: "confirmed" }));
      // One crank tick (the ER does this automatically on devnet).
      await R(() => sentinel.methods.evaluate().accounts({ guard, priceFeed: price }).rpc({ commitment: "confirmed" }));
      console.log("   price", (p / 1e6).toFixed(2));

      // The instant the stop is crossed, settle — permissionless, vault-signed CPI.
      if (!closed && p <= STOP) {
        await sleep(700);
        await R(() =>
          sentinel.methods
            .executeProtection()
            .accounts({ guard, vault, flashProgram: venue.programId, cranker: trader })
            .remainingAccounts(closeRem())
            .signers([traderKp])
            .rpc({ commitment: "confirmed" }),
        );
        closed = true;
        console.log("   ✅ protection executed — guarded position closed at the stop");
      }
      await sleep(900);
    }
    await sleep(3000);
  });

  after(() => setTimeout(() => process.exit(0), 200));
});
