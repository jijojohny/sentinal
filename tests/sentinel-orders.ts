/**
 * Sentinel — order-engine + liquidation-defense features (Phases 1–2).
 *   1. OCO bracket: one guard with a stop AND a take-profit; either fires.
 *   2. Breakeven stop: the crank moves the stop up to entry once in profit.
 *   3. Liquidation defense: on trip, add margin (keep the position open) instead of closing.
 *
 * Local: `evaluate` is called directly to simulate crank ticks.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { FlashStub } from "../target/types/flash_stub";
import { assert } from "chai";

describe("sentinel-orders", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const venue = anchor.workspace.FlashStub as Program<FlashStub>;

  const pid = sentinel.programId;
  const pda = (s: (Buffer | Uint8Array)[], p = pid) => web3.PublicKey.findProgramAddressSync(s, p)[0];
  const gid = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);

  // Fresh trader per run; one trader, three guard_ids (multi-position registry).
  const traderKp = web3.Keypair.generate();
  const trader = traderKp.publicKey;
  const vault = pda([Buffer.from("vault"), trader.toBuffer()]);
  const market = web3.Keypair.generate().publicKey;
  const dummy = web3.Keypair.generate().publicKey;
  const sysId = web3.SystemProgram.programId;
  const m = (pk: web3.PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });

  const baseParams = (over: any) => ({
    guardId: new BN(0), market, side: 1, rule: { priceBelow: {} }, action: { close: {} }, kind: { protect: {} },
    triggerPrice: new BN(0), trailDistance: new BN(0), tpPrice: new BN(0), breakevenOffset: new BN(0),
    expiryTs: new BN(0), marginAmount: new BN(0), keeperBounty: new BN(0), volK: new BN(0),
    entrySize: new BN(0), entryCollateral: new BN(0), tpLadder: [new BN(0), new BN(0), new BN(0)],
    bracketStop: new BN(0), settleDelay: new BN(0),
    closePriceLimit: new BN(0), initialPrice: new BN(100_000_000),
    ...over,
  });
  const register = (id: number, over: any) =>
    sentinel.methods.registerGuard(baseParams({ guardId: new BN(id), ...over }))
      .accounts({ authority: trader, vault, guard: pda([Buffer.from("guard"), vault.toBuffer(), gid(id)]), priceFeed: pda([Buffer.from("price"), vault.toBuffer(), gid(id)]), payer: trader, sessionToken: null })
      .signers([traderKp]).rpc({ commitment: "confirmed" });
  const tick = async (id: number, p: number) => {
    const price = pda([Buffer.from("price"), vault.toBuffer(), gid(id)]);
    const guard = pda([Buffer.from("guard"), vault.toBuffer(), gid(id)]);
    await sentinel.methods.pushPrice(new BN(p), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: price }).rpc({ commitment: "confirmed" });
    await sentinel.methods.evaluate().accounts({ guard, priceFeed: price }).rpc({ commitment: "confirmed" });
    return sentinel.account.guardConfig.fetch(guard);
  };

  before(async () => {
    await provider.sendAndConfirm(
      new web3.Transaction()
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: trader, lamports: 1 * web3.LAMPORTS_PER_SOL }))
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vault, lamports: 0.05 * web3.LAMPORTS_PER_SOL })),
      [], { commitment: "confirmed" },
    );
  });

  it("OCO bracket — take-profit side fires", async () => {
    await register(0, { triggerPrice: new BN(95_000_000), tpPrice: new BN(110_000_000) });
    let g = await tick(0, 105_000_000);
    assert.equal(g.triggered, false);
    g = await tick(0, 111_000_000); // crosses TP
    assert.equal(g.triggered, true);
    assert.equal(g.tripReason, 2); // TRIP_TP
    console.log("   OCO take-profit fired (reason", g.tripReason + ")");
  });

  it("breakeven stop — crank moves stop to entry, then fires", async () => {
    await register(1, { triggerPrice: new BN(92_000_000), breakevenOffset: new BN(5_000_000) });
    let g = await tick(1, 106_000_000); // ≥ entry+5 → arm breakeven, stop→entry(100)
    assert.equal(g.breakevenArmed, true);
    assert.equal(g.triggerPrice.toNumber(), 100_000_000);
    assert.equal(g.triggered, false);
    g = await tick(1, 99_000_000); // pulls back below breakeven stop
    assert.equal(g.triggered, true);
    assert.equal(g.tripReason, 1); // TRIP_STOP
    console.log("   breakeven stop moved to entry then fired");
  });

  it("liquidation defense — adds margin instead of closing", async () => {
    const guard = pda([Buffer.from("guard"), vault.toBuffer(), gid(2)]);
    const position = pda([Buffer.from("position"), vault.toBuffer()], venue.programId);
    const openRem = () => [m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(position, true), m(dummy, true), m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false), m(sysId, false)];
    const addRem = () => [m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(position, true), m(dummy, true), m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false)];

    await sentinel.methods.openProtectedPosition({ price: new BN(100_000_000), collateral: new BN(10_000_000), size: new BN(100_000_000), side: 1 })
      .accounts({ vault, owner: trader, flashProgram: venue.programId, trader }).remainingAccounts(openRem()).signers([traderKp]).rpc({ commitment: "confirmed" });
    await register(2, { triggerPrice: new BN(95_000_000), action: { addMargin: {} }, marginAmount: new BN(5_000_000) });
    const before = await venue.account.position.fetch(position);

    await tick(2, 94_000_000); // trip
    await sentinel.methods.executeProtection()
      .accounts({ guard, vault, flashProgram: venue.programId, cranker: trader }).remainingAccounts(addRem()).signers([traderKp]).rpc({ commitment: "confirmed" });

    const after = await venue.account.position.fetch(position); // still open!
    assert.equal(after.open, true);
    assert.isAbove(after.collateral.toNumber(), before.collateral.toNumber());
    console.log("   margin added:", before.collateral.toNumber() / 1e6, "→", after.collateral.toNumber() / 1e6, "— position kept alive");
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
