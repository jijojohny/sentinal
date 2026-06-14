/**
 * Sentinel — Round-2 features:
 *   1. Incentivized keeper bounty (the cranker that settles gets paid by the vault).
 *   2. Limit-entry order (the crank opens a position when price crosses the entry).
 *   3. Take-profit ladder / scale-out (partial closes across rungs, re-arming each time).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { FlashStub } from "../target/types/flash_stub";
import { assert } from "chai";

describe("sentinel-round2", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const venue = anchor.workspace.FlashStub as Program<FlashStub>;
  const pid = sentinel.programId;
  const pda = (s: (Buffer | Uint8Array)[], p = pid) => web3.PublicKey.findProgramAddressSync(s, p)[0];
  const gid = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);

  const trader = web3.Keypair.generate();
  const vault = pda([Buffer.from("vault"), trader.publicKey.toBuffer()]);
  const market = web3.Keypair.generate().publicKey;
  const dummy = web3.Keypair.generate().publicKey;
  const sysId = web3.SystemProgram.programId;
  const m = (pk: web3.PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });
  const guardOf = (id: number) => pda([Buffer.from("guard"), vault.toBuffer(), gid(id)]);
  const priceOf = (id: number) => pda([Buffer.from("price"), vault.toBuffer(), gid(id)]);
  const position = pda([Buffer.from("position"), vault.toBuffer()], venue.programId);
  const openRem = () => [m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(position, true), m(dummy, true), m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false), m(sysId, false)];
  const closeRem = () => [m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(position, true), m(dummy, true), m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false)];

  const reg = (id: number, over: any) =>
    sentinel.methods.registerGuard({
      guardId: new BN(id), market, side: 1, rule: { priceBelow: {} }, action: { close: {} }, kind: { protect: {} },
      triggerPrice: new BN(0), trailDistance: new BN(0), tpPrice: new BN(0), breakevenOffset: new BN(0),
      expiryTs: new BN(0), marginAmount: new BN(0), keeperBounty: new BN(0), volK: new BN(0),
      entrySize: new BN(0), entryCollateral: new BN(0), tpLadder: [new BN(0), new BN(0), new BN(0)],
      bracketStop: new BN(0), settleDelay: new BN(0),
      closePriceLimit: new BN(94_000_000), initialPrice: new BN(100_000_000), ...over,
    }).accounts({ authority: trader.publicKey, vault, guard: guardOf(id), priceFeed: priceOf(id), payer: trader.publicKey, sessionToken: null }).signers([trader]).rpc({ commitment: "confirmed" });
  const tick = async (id: number, p: number) => {
    await sentinel.methods.pushPrice(new BN(p), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: priceOf(id) }).rpc({ commitment: "confirmed" });
    await sentinel.methods.evaluate().accounts({ guard: guardOf(id), priceFeed: priceOf(id) }).rpc({ commitment: "confirmed" });
  };
  const openPos = (size: number) =>
    sentinel.methods.openProtectedPosition({ price: new BN(100_000_000), collateral: new BN(10_000_000), size: new BN(size), side: 1 })
      .accounts({ vault, owner: trader.publicKey, flashProgram: venue.programId, trader: trader.publicKey }).remainingAccounts(openRem()).signers([trader]).rpc({ commitment: "confirmed" });

  before(async () => {
    await provider.sendAndConfirm(
      new web3.Transaction()
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: trader.publicKey, lamports: 2 * web3.LAMPORTS_PER_SOL }))
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vault, lamports: 0.3 * web3.LAMPORTS_PER_SOL })),
      [], { commitment: "confirmed" });
  });

  it("pays a keeper bounty to whoever settles", async () => {
    const BOUNTY = 0.02 * web3.LAMPORTS_PER_SOL;
    await openPos(100_000_000);
    await reg(0, { triggerPrice: new BN(95_000_000), keeperBounty: new BN(BOUNTY) });
    await tick(0, 92_000_000); // trips the stop
    const cranker = web3.Keypair.generate();
    await provider.sendAndConfirm(new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: cranker.publicKey, lamports: 0.05 * web3.LAMPORTS_PER_SOL })), [], { commitment: "confirmed" });
    const before = await provider.connection.getBalance(cranker.publicKey);
    await sentinel.methods.executeProtection().accounts({ guard: guardOf(0), vault, flashProgram: venue.programId, cranker: cranker.publicKey, systemProgram: sysId }).remainingAccounts(closeRem()).signers([cranker]).rpc({ commitment: "confirmed" });
    const after = await provider.connection.getBalance(cranker.publicKey);
    assert.isAbove(after, before, "cranker should earn the bounty net of fees");
    console.log("   keeper earned", (after - before) / web3.LAMPORTS_PER_SOL, "SOL bounty");
  });

  it("fills a limit-entry order when price crosses", async () => {
    await reg(1, { kind: { entry: {} }, rule: { priceBelow: {} }, triggerPrice: new BN(95_000_000), entrySize: new BN(50_000_000), entryCollateral: new BN(8_000_000) });
    await tick(1, 94_000_000); // crosses entry → triggered
    await sentinel.methods.executeEntry().accounts({ guard: guardOf(1), vault, flashProgram: venue.programId, cranker: trader.publicKey, systemProgram: sysId }).remainingAccounts(openRem()).signers([trader]).rpc({ commitment: "confirmed" });
    const pos = await venue.account.position.fetch(position);
    assert.equal(pos.open, true);
    console.log("   limit entry filled — position open @", pos.entryPrice.toString());
  });

  it("scales out across a take-profit ladder", async () => {
    // Fresh trader → own vault/position (the stub holds one position per vault).
    const tL = web3.Keypair.generate();
    const vL = pda([Buffer.from("vault"), tL.publicKey.toBuffer()]);
    const posL = pda([Buffer.from("position"), vL.toBuffer()], venue.programId);
    const guardL = pda([Buffer.from("guard"), vL.toBuffer(), gid(0)]);
    const priceL = pda([Buffer.from("price"), vL.toBuffer(), gid(0)]);
    const rem = (last: web3.PublicKey, n: number) => {
      const a = [m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(posL, true), m(dummy, true), m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false)];
      if (n === 12) a.push(m(sysId, false));
      return a;
    };
    await provider.sendAndConfirm(new web3.Transaction()
      .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: tL.publicKey, lamports: 1 * web3.LAMPORTS_PER_SOL }))
      .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vL, lamports: 0.1 * web3.LAMPORTS_PER_SOL })), [], { commitment: "confirmed" });

    await sentinel.methods.openProtectedPosition({ price: new BN(100_000_000), collateral: new BN(10_000_000), size: new BN(90_000_000), side: 1 })
      .accounts({ vault: vL, owner: tL.publicKey, flashProgram: venue.programId, trader: tL.publicKey }).remainingAccounts(rem(posL, 12)).signers([tL]).rpc({ commitment: "confirmed" });
    await sentinel.methods.registerGuard({
      guardId: new BN(0), market, side: 1, rule: { priceBelow: {} }, action: { close: {} }, kind: { protect: {} },
      triggerPrice: new BN(0), trailDistance: new BN(0), tpPrice: new BN(0), breakevenOffset: new BN(0), expiryTs: new BN(0),
      marginAmount: new BN(0), keeperBounty: new BN(0), volK: new BN(0), entrySize: new BN(90_000_000), entryCollateral: new BN(0),
      tpLadder: [new BN(105_000_000), new BN(110_000_000), new BN(115_000_000)], bracketStop: new BN(0), settleDelay: new BN(0), closePriceLimit: new BN(0), initialPrice: new BN(100_000_000),
    }).accounts({ authority: tL.publicKey, vault: vL, guard: guardL, priceFeed: priceL, payer: tL.publicKey, sessionToken: null }).signers([tL]).rpc({ commitment: "confirmed" });

    for (const [px, doneExp] of [[106_000_000, 1], [111_000_000, 2], [116_000_000, 3]] as const) {
      await sentinel.methods.pushPrice(new BN(px), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: priceL }).rpc({ commitment: "confirmed" });
      await sentinel.methods.evaluate().accounts({ guard: guardL, priceFeed: priceL }).rpc({ commitment: "confirmed" });
      await sentinel.methods.executeProtection().accounts({ guard: guardL, vault: vL, flashProgram: venue.programId, cranker: tL.publicKey, systemProgram: sysId }).remainingAccounts(rem(posL, 11)).signers([tL]).rpc({ commitment: "confirmed" });
      const g = await sentinel.account.guardConfig.fetch(guardL);
      assert.equal(g.ladderDone, doneExp);
    }
    const pos = await venue.account.position.fetch(posL);
    assert.equal(pos.size.toNumber(), 0);
    console.log("   ladder scaled out fully across 3 rungs");
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
