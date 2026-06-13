/**
 * Sentinel — settlement vertical slice on a LOCAL validator (free SOL).
 *
 * Proves the SETTLEMENT half end to end:
 *   1. initialize_vault
 *   2. open_protected_position  → vault PDA opens a position on the venue (flash_stub)
 *                                  via CPI, signed by the vault (vault is the owner)
 *   3. register_guard           → stop-loss rule + price feed
 *   4. push_price (crash)       → price drops below the stop
 *   5. evaluate (direct call)   → simulates ONE crank tick → flips `triggered`
 *   6. execute_protection       → permissionless CPI closes the position via the vault PDA
 *
 * The autonomous crank (the ER auto-calling `evaluate` with no server) and the
 * delegate/commit lifecycle are proven LIVE on devnet in sentinel-er-flow.ts /
 * sentinel-settlement-slice.ts. Here we call `evaluate` directly — it is an
 * ordinary instruction; the ER just invokes it on a schedule — to isolate and
 * prove the open→close CPI mechanics without ER infra.
 *
 * Run: ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 against a local validator with
 * both programs deployed (see scripts/run-local-settlement.sh).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { FlashStub } from "../target/types/flash_stub";
import { assert } from "chai";

const VAULT_SEED = "vault";
const GUARD_SEED = "guard";
const PRICE_SEED = "price";

describe("sentinel-settlement-local", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const venue = anchor.workspace.FlashStub as Program<FlashStub>;
  // Fresh trader each run → fresh PDAs → repeatable without resetting the validator.
  const traderKp = web3.Keypair.generate();
  const trader = traderKp.publicKey;

  const [vaultPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), trader.toBuffer()], sentinel.programId);
  const [guardPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from(GUARD_SEED), vaultPDA.toBuffer()], sentinel.programId);
  const [pricePDA] = web3.PublicKey.findProgramAddressSync([Buffer.from(PRICE_SEED), vaultPDA.toBuffer()], sentinel.programId);
  const [positionPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("position"), vaultPDA.toBuffer()], venue.programId);

  const market = web3.Keypair.generate().publicKey;
  const dummy = web3.Keypair.generate().publicKey;
  const sysId = web3.SystemProgram.programId;
  const ENTRY = new BN(100_000_000);
  const STOP = new BN(95_000_000);

  const m = (pk: web3.PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });
  const openRemaining = () => [
    m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(positionPDA, true), m(dummy, true),
    m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false), m(sysId, false),
  ];
  const closeRemaining = () => [
    m(dummy, true), m(dummy, false), m(dummy, false), m(market, true), m(positionPDA, true), m(dummy, true),
    m(dummy, false), m(dummy, true), m(dummy, false), m(dummy, true), m(sysId, false),
  ];

  before(async () => {
    // Fund the fresh trader + the vault PDA (the vault is the position owner and
    // pays the position rent on open — the trader's collateral deposit, abstracted).
    await provider.sendAndConfirm(
      new web3.Transaction()
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: trader, lamports: 0.5 * web3.LAMPORTS_PER_SOL }))
        .add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPDA, lamports: 0.05 * web3.LAMPORTS_PER_SOL })),
      [],
      { commitment: "confirmed" },
    );
    console.log("   fresh trader:", trader.toBase58());
  });

  it("vault opens a position via CPI (Flash interface)", async () => {
    await sentinel.methods
      .openProtectedPosition({ price: ENTRY, collateral: new BN(10_000_000), size: new BN(100_000_000), side: 1 })
      .accounts({ vault: vaultPDA, owner: trader, flashProgram: venue.programId, trader })
      .remainingAccounts(openRemaining())
      .signers([traderKp])
      .rpc({ commitment: "confirmed" });
    const pos = await venue.account.position.fetch(positionPDA);
    assert.equal(pos.open, true);
    console.log("   position OPEN @", pos.entryPrice.toString());
  });

  it("guard trips when price crashes (one crank tick)", async () => {
    await sentinel.methods
      .registerGuard({ market, side: 1, rule: { priceBelow: {} }, triggerPrice: STOP, trailDistance: new BN(0), closePriceLimit: new BN(94_000_000), initialPrice: ENTRY })
      .accounts({ vault: vaultPDA, owner: trader, guard: guardPDA, priceFeed: pricePDA, trader })
      .signers([traderKp])
      .rpc({ commitment: "confirmed" });

    await sentinel.methods.pushPrice(new BN(92_000_000), new BN(Math.floor(Date.now() / 1000))).accounts({ priceFeed: pricePDA }).rpc({ commitment: "confirmed" });
    // One crank tick (the ER does this automatically on devnet; here we call it directly).
    await sentinel.methods.evaluate().accounts({ guard: guardPDA, priceFeed: pricePDA }).rpc({ commitment: "confirmed" });

    const guard = await sentinel.account.guardConfig.fetch(guardPDA);
    assert.equal(guard.triggered, true);
    console.log("   guard TRIPPED at", guard.lastPrice.toString());
  });

  it("execute_protection closes the position via the vault PDA (permissionless)", async () => {
    await sentinel.methods
      .executeProtection()
      .accounts({ guard: guardPDA, vault: vaultPDA, flashProgram: venue.programId, cranker: trader })
      .remainingAccounts(closeRemaining())
      .signers([traderKp])
      .rpc({ commitment: "confirmed" });

    const info = await provider.connection.getAccountInfo(positionPDA);
    assert.equal(info, null, "position should be closed");
    const guard = await sentinel.account.guardConfig.fetch(guardPDA);
    assert.equal(guard.executed, true);
    console.log("   ✅ position CLOSED by Sentinel — vault-signed CPI, non-custodial");
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
