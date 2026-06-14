/**
 * Sentinel — bracket orders + anti-MEV settle-lock.
 *   1. Bracket: a limit entry that, on fill, auto-arms a protective stop (+ TP).
 *   2. Anti-MEV: settlement is time-locked after a trip; an immediate settle is rejected,
 *      and only succeeds once the (randomized) delay has elapsed.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { FlashStub } from "../target/types/flash_stub";
import { assert } from "chai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sentinel-round3", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const venue = anchor.workspace.FlashStub as Program<FlashStub>;
  const pid = sentinel.programId;
  const pda = (s: (Buffer | Uint8Array)[], p = pid) => web3.PublicKey.findProgramAddressSync(s, p)[0];
  const gidb = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);
  const market = web3.Keypair.generate().publicKey;
  const dummy = web3.Keypair.generate().publicKey;
  const sysId = web3.SystemProgram.programId;
  const m = (pk: web3.PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });

  async function fresh() {
    const t = web3.Keypair.generate();
    const vault = pda([Buffer.from("vault"), t.publicKey.toBuffer()]);
    const position = pda([Buffer.from("position"), vault.toBuffer()], venue.programId);
    await provider.sendAndConfirm(new web3.Transaction()
      .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: t.publicKey, lamports: 1 * web3.LAMPORTS_PER_SOL }))
      .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vault, lamports: 0.1 * web3.LAMPORTS_PER_SOL })), [], { commitment: "confirmed" });
    return { t, vault, position };
  }
  const openRem = (position: web3.PublicKey) => [m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(position, true), m(dummy, true), m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false), m(sysId, false)];
  const closeRem = (position: web3.PublicKey) => openRem(position).slice(0, 11);
  const P = (over: any) => ({
    guardId: new BN(0), market, side: 1, rule: { priceBelow: {} }, action: { close: {} }, kind: { protect: {} },
    triggerPrice: new BN(0), trailDistance: new BN(0), tpPrice: new BN(0), breakevenOffset: new BN(0), expiryTs: new BN(0),
    marginAmount: new BN(0), keeperBounty: new BN(0), volK: new BN(0), entrySize: new BN(0), entryCollateral: new BN(0),
    tpLadder: [new BN(0), new BN(0), new BN(0)], bracketStop: new BN(0), settleDelay: new BN(0),
    closePriceLimit: new BN(94_000_000), initialPrice: new BN(100_000_000), ...over,
  });
  const reg = (t: any, vault: web3.PublicKey, over: any) =>
    sentinel.methods.registerGuard(P(over)).accounts({ authority: t.publicKey, vault, guard: pda([Buffer.from("guard"), vault.toBuffer(), gidb(0)]), priceFeed: pda([Buffer.from("price"), vault.toBuffer(), gidb(0)]), payer: t.publicKey, sessionToken: null }).signers([t]).rpc({ commitment: "confirmed" });
  const tick = async (vault: web3.PublicKey, p: number) => {
    const price = pda([Buffer.from("price"), vault.toBuffer(), gidb(0)]);
    await sentinel.methods.pushPrice(new BN(p), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: price }).rpc({ commitment: "confirmed" });
    await sentinel.methods.evaluate().accounts({ guard: pda([Buffer.from("guard"), vault.toBuffer(), gidb(0)]), priceFeed: price }).rpc({ commitment: "confirmed" });
  };
  const guardOf = (vault: web3.PublicKey) => pda([Buffer.from("guard"), vault.toBuffer(), gidb(0)]);

  it("bracket order: limit fill auto-arms a protective stop", async () => {
    const { t, vault, position } = await fresh();
    await reg(t, vault, { kind: { entry: {} }, triggerPrice: new BN(95_000_000), bracketStop: new BN(92_000_000), tpPrice: new BN(110_000_000), entrySize: new BN(50_000_000), entryCollateral: new BN(8_000_000) });
    await tick(vault, 94_000_000); // crosses entry → triggered
    await sentinel.methods.executeEntry().accounts({ guard: guardOf(vault), vault, flashProgram: venue.programId, cranker: t.publicKey, systemProgram: sysId }).remainingAccounts(openRem(position)).signers([t]).rpc({ commitment: "confirmed" });
    let g = await sentinel.account.guardConfig.fetch(guardOf(vault));
    assert.isOk(g.kind.protect, "entry converted to a protect guard");
    assert.equal(g.triggerPrice.toNumber(), 92_000_000, "bracket stop armed");
    assert.equal(g.active, true); assert.equal(g.executed, false);
    console.log("   bracket armed on fill: stop $92, tp $110");

    await tick(vault, 91_000_000); // hits the bracket stop
    await sentinel.methods.executeProtection().accounts({ guard: guardOf(vault), vault, flashProgram: venue.programId, cranker: t.publicKey, systemProgram: sysId }).remainingAccounts(closeRem(position)).signers([t]).rpc({ commitment: "confirmed" });
    g = await sentinel.account.guardConfig.fetch(guardOf(vault));
    assert.equal(g.executed, true, "bracket stop closed the position");
    console.log("   bracket stop fired — position protected");
  });

  it("anti-MEV: settlement is time-locked after a trip", async () => {
    const { t, vault, position } = await fresh();
    await sentinel.methods.openProtectedPosition({ price: new BN(100_000_000), collateral: new BN(10_000_000), size: new BN(100_000_000), side: 1 })
      .accounts({ vault, owner: t.publicKey, flashProgram: venue.programId, trader: t.publicKey }).remainingAccounts(openRem(position)).signers([t]).rpc({ commitment: "confirmed" });
    await reg(t, vault, { triggerPrice: new BN(95_000_000), settleDelay: new BN(2) });
    await tick(vault, 92_000_000); // trips → settle locked for ~2-4s

    let blocked = false;
    try {
      await sentinel.methods.executeProtection().accounts({ guard: guardOf(vault), vault, flashProgram: venue.programId, cranker: t.publicKey, systemProgram: sysId }).remainingAccounts(closeRem(position)).signers([t]).rpc({ commitment: "confirmed", skipPreflight: false });
    } catch { blocked = true; }
    assert.isTrue(blocked, "immediate settle must be rejected (anti-MEV lock)");
    console.log("   immediate settle blocked by anti-MEV lock");

    await sleep(6000); // wait out the delay + jitter
    await sentinel.methods.executeProtection().accounts({ guard: guardOf(vault), vault, flashProgram: venue.programId, cranker: t.publicKey, systemProgram: sysId }).remainingAccounts(closeRem(position)).signers([t]).rpc({ commitment: "confirmed" });
    const g = await sentinel.account.guardConfig.fetch(guardOf(vault));
    assert.equal(g.executed, true, "settles after the lock elapses");
    console.log("   settled after the anti-MEV delay elapsed");
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
