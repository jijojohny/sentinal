/**
 * Sentinel — trailing-stop ratchet (the headline ER feature).
 *
 * Proves the crank ratchets the stop UP as price rises (never down), then fires
 * when price reverses past the trailed level. On devnet this runs every tick in
 * the rollup, gaslessly, with no server — continuous on-chain trailing, which is
 * exactly what's impossible on base Solana.
 *
 * Local: we call `evaluate` directly to simulate ticks.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { assert } from "chai";

describe("sentinel-trailing", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;

  const traderKp = web3.Keypair.generate();
  const trader = traderKp.publicKey;
  const pda = (s: (Buffer | Uint8Array)[]) => web3.PublicKey.findProgramAddressSync(s, sentinel.programId)[0];
  const vault = pda([Buffer.from("vault"), trader.toBuffer()]);
  const guard = pda([Buffer.from("guard"), vault.toBuffer()]);
  const price = pda([Buffer.from("price"), vault.toBuffer()]);
  const market = web3.Keypair.generate().publicKey;

  const ENTRY = 100_000_000, TRAIL = 8_000_000;

  const tick = async (p: number) => {
    await sentinel.methods.pushPrice(new BN(p), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: price }).rpc({ commitment: "confirmed" });
    await sentinel.methods.evaluate().accounts({ guard, priceFeed: price }).rpc({ commitment: "confirmed" });
    return sentinel.account.guardConfig.fetch(guard);
  };

  before(async () => {
    await provider.sendAndConfirm(
      new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: trader, lamports: 0.3 * web3.LAMPORTS_PER_SOL })),
      [],
      { commitment: "confirmed" },
    );
  });

  it("ratchets the stop up as price rises, fires on reversal", async () => {
    await sentinel.methods
      .registerGuard({ market, side: 1, rule: { trailingStop: {} }, triggerPrice: new BN(ENTRY - TRAIL), trailDistance: new BN(TRAIL), closePriceLimit: new BN(0), initialPrice: new BN(ENTRY) })
      .accounts({ vault, guard, priceFeed: price, trader })
      .signers([traderKp])
      .rpc({ commitment: "confirmed" });

    let g = await tick(105_000_000); // stop → 97
    assert.equal(g.triggerPrice.toNumber(), 97_000_000);
    assert.equal(g.triggered, false);

    g = await tick(110_000_000); // new high → stop → 102
    assert.equal(g.triggerPrice.toNumber(), 102_000_000);
    assert.equal(g.triggered, false);
    console.log("   stop ratcheted up to", g.triggerPrice.toNumber() / 1e6, "(high-water", g.highWater.toNumber() / 1e6, ")");

    g = await tick(104_000_000); // pullback, stop holds at 102, not tripped
    assert.equal(g.triggerPrice.toNumber(), 102_000_000);
    assert.equal(g.triggered, false);

    g = await tick(101_000_000); // reversal past trailed stop → fires
    assert.equal(g.triggered, true);
    console.log("   ✅ trailing stop fired at", (101_000_000 / 1e6).toFixed(2), "— locked in gains above entry");
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
