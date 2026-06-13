/**
 * Sentinel — settlement vertical slice (the demo payoff).
 *
 * Full guardian lifecycle on devnet, end to end:
 *   1. initialize_vault
 *   2. open_protected_position  → vault PDA opens a position on the venue (flash_stub),
 *                                  signed by the vault via CPI (vault is the owner)
 *   3. register_guard + delegate → stop-loss rule + price feed, delegated to the rollup
 *   4. schedule_monitor          → crank starts; NO server from here
 *   5. push_price (crash)        → price drops below the stop, gaslessly in the rollup
 *   6. crank evaluate            → flips `triggered` on its own
 *   7. commit_guard              → triggered state committed to L1
 *   8. execute_protection        → permissionless CPI closes the position via the vault PDA
 *
 * Asserts the position account exists after step 2 and is GONE after step 8 — the
 * on-chain proof that the guard auto-closed the trade with no server and no custody.
 *
 * The venue is `flash_stub`, which mirrors Flash's open/close interface exactly
 * (same discriminators, account order, params). Sentinel's CPI here is byte-identical
 * to the one it makes against the real Flash reference program.
 *
 * Uses a fresh, transfer-funded trader each run so it is repeatable on persistent
 * devnet state (no PDA collisions, no airdrop dependency).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { FlashStub } from "../target/types/flash_stub";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert } from "chai";

const VAULT_SEED = "vault";
const GUARD_SEED = "guard";
const PRICE_SEED = "price";

describe("sentinel-settlement-slice", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const erConn = new anchor.web3.Connection(
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-as.magicblock.app/",
    { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-as.magicblock.app/" },
  );

  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const venue = anchor.workspace.FlashStub as Program<FlashStub>;

  // Fresh trader each run → fresh PDAs → repeatable on persistent devnet state.
  const trader = web3.Keypair.generate();

  const [vaultPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), trader.publicKey.toBuffer()],
    sentinel.programId,
  );
  const [guardPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(GUARD_SEED), vaultPDA.toBuffer()],
    sentinel.programId,
  );
  const [pricePDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(PRICE_SEED), vaultPDA.toBuffer()],
    sentinel.programId,
  );
  const [positionPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("position"), vaultPDA.toBuffer()],
    venue.programId,
  );

  const market = web3.Keypair.generate().publicKey;
  const dummy = web3.Keypair.generate().publicKey;
  const ENTRY = new BN(100_000_000);
  const STOP = new BN(95_000_000);

  const sysId = web3.SystemProgram.programId;
  const meta = (pk: web3.PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });
  // Flash open order (minus owner): funding, transferAuth, perpetuals, pool, position,
  // custody, custodyOracle, collCustody, collOracle, collTokenAcct, system, token.
  const flashOpenRemaining = () => [
    meta(dummy, true), meta(dummy, false), meta(dummy, false), meta(market, true),
    meta(positionPDA, true), meta(dummy, true), meta(dummy, false), meta(dummy, true),
    meta(dummy, false), meta(dummy, true), meta(sysId, false), meta(sysId, false),
  ];
  // Flash close order (minus owner): receiving, transferAuth, perpetuals, pool, position,
  // custody, custodyOracle, collCustody, collOracle, collTokenAcct, token.
  const flashCloseRemaining = () => [
    meta(dummy, true), meta(dummy, false), meta(dummy, false), meta(market, true),
    meta(positionPDA, true), meta(dummy, true), meta(dummy, false), meta(dummy, true),
    meta(dummy, false), meta(dummy, true), meta(sysId, false),
  ];

  const sendER = async (tx: web3.Transaction) => {
    tx.feePayer = provider.wallet.publicKey;
    tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;
    const signed = await provider.wallet.signTransaction(tx);
    const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    await erConn.confirmTransaction(sig, "confirmed");
    return sig;
  };

  before(async () => {
    // Fund the fresh trader + the data-less vault PDA (the vault is the position
    // owner and pays the position rent on open).
    const tx = new web3.Transaction()
      .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: trader.publicKey, lamports: 0.25 * web3.LAMPORTS_PER_SOL }))
      .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPDA, lamports: 0.05 * web3.LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    console.log("   fresh trader:", trader.publicKey.toBase58());
  });

  it("open a vault-owned position via CPI", async () => {
    await sentinel.methods
      .openProtectedPosition({ price: ENTRY, collateral: new BN(10_000_000), size: new BN(100_000_000), side: 1 })
      .accounts({ vault: vaultPDA, owner: trader.publicKey, flashProgram: venue.programId, trader: trader.publicKey })
      .remainingAccounts(flashOpenRemaining())
      .signers([trader])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    const pos = await venue.account.position.fetch(positionPDA);
    assert.equal(pos.open, true);
    console.log("   position OPEN @", pos.entryPrice.toString());
  });

  it("register guard (stop @ $95) + delegate to the rollup", async () => {
    await sentinel.methods
      .registerGuard({ market, side: 1, rule: { priceBelow: {} }, triggerPrice: STOP, trailDistance: new BN(0), closePriceLimit: new BN(94_000_000), initialPrice: ENTRY })
      .accounts({ vault: vaultPDA, owner: trader.publicKey, guard: guardPDA, priceFeed: pricePDA, trader: trader.publicKey })
      .signers([trader])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    await sentinel.methods
      .delegateGuard()
      .accounts({ payer: trader.publicKey })
      .signers([trader])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
  });

  it("schedule the crank, crash the price, let it trip (no server)", async () => {
    await sendER(
      await sentinel.methods
        .scheduleMonitor({ taskId: new BN(7), executionIntervalMillis: new BN(100), iterations: new BN(50) })
        .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: provider.wallet.publicKey, guard: guardPDA, priceFeed: pricePDA, program: sentinel.programId })
        .transaction(),
    );
    await sendER(
      await sentinel.methods
        .pushPrice(new BN(92_000_000), new BN(Math.floor(Date.now() / 1000)))
        .accounts({ priceFeed: pricePDA })
        .transaction(),
    );

    await new Promise((r) => setTimeout(r, 2500));
    const erSentinel = new Program<Sentinel>(sentinel.idl, new anchor.AnchorProvider(erConn, provider.wallet as anchor.Wallet, {}));
    const guard = await erSentinel.account.guardConfig.fetch(guardPDA);
    assert.equal(guard.triggered, true, "crank should trip the guard with no server");
    console.log("   crank tripped guard at price", guard.lastPrice.toString());
  });

  it("commit the trigger to L1, then permissionlessly execute protection", async () => {
    await sendER(
      await sentinel.methods.commitGuard().accounts({ payer: provider.wallet.publicKey, guard: guardPDA }).transaction(),
    );
    await new Promise((r) => setTimeout(r, 2500));

    await sentinel.methods
      .executeProtection()
      .accounts({ guard: guardPDA, vault: vaultPDA, flashProgram: venue.programId, cranker: trader.publicKey })
      .remainingAccounts(flashCloseRemaining())
      .signers([trader])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    const info = await provider.connection.getAccountInfo(positionPDA);
    assert.equal(info, null, "position should be closed by execute_protection");
    const guard = await sentinel.account.guardConfig.fetch(guardPDA);
    assert.equal(guard.executed, true);
    console.log("   ✅ position CLOSED by Sentinel — no server, non-custodial");
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
