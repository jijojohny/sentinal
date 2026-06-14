/**
 * Sentinel — autonomous grid / DCA bot (Phase 6).
 * The crank decides rungs on-chain each tick (no server): grid mode fills on
 * level crossings, DCA mode fills on a fixed tick cadence. Local: grid_step is
 * called directly to simulate ticks.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { assert } from "chai";

describe("sentinel-grid", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const pid = sentinel.programId;
  const pda = (s: (Buffer | Uint8Array)[]) => web3.PublicKey.findProgramAddressSync(s, pid)[0];
  const gid = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);

  const traderKp = web3.Keypair.generate();
  const trader = traderKp.publicKey;
  const market = web3.Keypair.generate().publicKey;
  const vault = pda([Buffer.from("vault"), trader.toBuffer()]);

  const gridPda = (id: number) => pda([Buffer.from("grid"), vault.toBuffer(), gid(id)]);
  const feedPda = (gridKey: web3.PublicKey) => pda([Buffer.from("price"), gridKey.toBuffer()]);

  before(async () => {
    await provider.sendAndConfirm(
      new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: trader, lamports: 1 * web3.LAMPORTS_PER_SOL })),
      [], { commitment: "confirmed" },
    );
  });

  const step = async (grid: web3.PublicKey, feed: web3.PublicKey, p: number) => {
    await sentinel.methods.pushPrice(new BN(p), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: feed }).rpc({ commitment: "confirmed" });
    await sentinel.methods.gridStep().accounts({ grid, gridFeed: feed }).rpc({ commitment: "confirmed" });
    return sentinel.account.gridConfig.fetch(grid);
  };

  it("grid mode fills on level crossings", async () => {
    const grid = gridPda(0);
    const feed = feedPda(grid);
    await sentinel.methods
      .initGrid({ gridId: new BN(0), market, lower: new BN(90_000_000), upper: new BN(110_000_000), levels: 5, orderSize: new BN(10_000_000), mode: 0, intervalTicks: 1, initialPrice: new BN(100_000_000) })
      .accounts({ vault, grid, gridFeed: feed, trader }).signers([traderKp]).rpc({ commitment: "confirmed" });

    await step(grid, feed, 96_000_000);  // level 1 (first observed, no fill)
    await step(grid, feed, 102_000_000); // -> 2  fill
    await step(grid, feed, 107_000_000); // -> 3  fill
    const g = await step(grid, feed, 93_000_000); // -> 0  fill
    assert.equal(g.fills, 3);
    console.log("   grid fills on crossings:", g.fills);
  });

  it("DCA mode fills on a fixed tick cadence", async () => {
    const grid = gridPda(1);
    const feed = feedPda(grid);
    await sentinel.methods
      .initGrid({ gridId: new BN(1), market, lower: new BN(0), upper: new BN(0), levels: 0, orderSize: new BN(10_000_000), mode: 1, intervalTicks: 2, initialPrice: new BN(100_000_000) })
      .accounts({ vault, grid, gridFeed: feed, trader }).signers([traderKp]).rpc({ commitment: "confirmed" });

    let g;
    for (let i = 0; i < 4; i++) g = await step(grid, feed, 100_000_000); // ticks 2 & 4 fill
    assert.equal(g!.fills, 2);
    console.log("   DCA fills every 2 ticks:", g!.fills);
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
