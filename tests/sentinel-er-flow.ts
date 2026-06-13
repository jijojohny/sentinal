/**
 * Sentinel — end-to-end Ephemeral Rollup flow.
 *
 * Proves the "impossible without ER" core: after one schedule_monitor tx, an
 * on-chain crank watches the price and flips `triggered` with NO server and NO
 * client transaction per tick. We then commit the triggered guard back to L1,
 * where execute_protection would CPI Flash close_position.
 *
 * Run against a local MagicBlock cluster (base validator + ER), same as the
 * crank-counter example: start the cluster, then `anchor test --skip-local-validator`
 * (or `yarn test:local`).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert } from "chai";

const VAULT_SEED = "vault";
const GUARD_SEED = "guard";
const PRICE_SEED = "price";

describe("sentinel-er-flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const erProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(
      process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-as.magicblock.app/",
      {
        wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-as.magicblock.app/",
      },
    ),
    anchor.Wallet.local(),
  );

  const program = anchor.workspace.Sentinel as Program<Sentinel>;
  const trader = provider.wallet.publicKey;

  const [vaultPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), trader.toBuffer()],
    program.programId,
  );
  const [guardPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(GUARD_SEED), vaultPDA.toBuffer()],
    program.programId,
  );
  const [pricePDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(PRICE_SEED), vaultPDA.toBuffer()],
    program.programId,
  );

  // A fake market id for the demo (in the full flow this is the Flash pool key).
  const market = web3.Keypair.generate().publicKey;
  const ENTRY = new BN(100_000_000); // $100.00 at 1e6
  const STOP = new BN(95_000_000); //  $95.00 stop

  it("initialize vault (base layer)", async () => {
    await program.methods
      .initializeVault()
      .accounts({ trader })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    const vault = await program.account.vault.fetch(vaultPDA);
    assert.equal(vault.owner.toBase58(), trader.toBase58());
  });

  it("register guard: long stop-loss at $95 (base layer)", async () => {
    await program.methods
      .registerGuard({
        market,
        side: 1, // Flash Side::Long (None=0, Long=1, Short=2)
        rule: { priceBelow: {} },
        triggerPrice: STOP,
        closePriceLimit: new BN(94_000_000), // allow some slippage on close
        initialPrice: ENTRY,
      })
      .accounts({ vault: vaultPDA, owner: trader, guard: guardPDA, priceFeed: pricePDA, trader })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    const guard = await program.account.guardConfig.fetch(guardPDA);
    assert.equal(guard.triggered, false);
    assert.equal(guard.active, true);
  });

  it("delegate guard + price feed to the rollup (base layer)", async () => {
    const isLocal =
      erProvider.connection.rpcEndpoint.includes("localhost") ||
      erProvider.connection.rpcEndpoint.includes("127.0.0.1");
    const validator = process.env.VALIDATOR
      ? new web3.PublicKey(process.env.VALIDATOR)
      : isLocal
        ? new web3.PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev")
        : null;
    const remaining = validator
      ? [{ pubkey: validator, isSigner: false, isWritable: false }]
      : [];
    await program.methods
      .delegateGuard()
      .accounts({ payer: trader })
      .remainingAccounts(remaining)
      .rpc({ skipPreflight: true, commitment: "confirmed" });
  });

  it("schedule the monitor crank (rollup) — no server from here", async () => {
    let tx = await program.methods
      .scheduleMonitor({
        taskId: new BN(1),
        executionIntervalMillis: new BN(100),
        iterations: new BN(50),
      })
      .accounts({
        magicProgram: MAGIC_PROGRAM_ID,
        payer: erProvider.wallet.publicKey,
        guard: guardPDA,
        priceFeed: pricePDA,
        program: program.programId,
      })
      .transaction();
    tx.feePayer = erProvider.wallet.publicKey;
    tx.recentBlockhash = (await erProvider.connection.getLatestBlockhash()).blockhash;
    tx = await erProvider.wallet.signTransaction(tx);
    await erProvider.sendAndConfirm(tx, [], { skipPreflight: true, commitment: "confirmed" });
  });

  it("crash the price below the stop (rollup, gasless) and let the crank fire", async () => {
    // Push a price under the stop. The scheduled crank should observe it and
    // flip `triggered` on its own — we send NO evaluate tx ourselves.
    let tx = await program.methods
      .pushPrice(new BN(92_000_000), new BN(Math.floor(Date.now() / 1000)))
      .accounts({ priceFeed: pricePDA })
      .transaction();
    tx.feePayer = erProvider.wallet.publicKey;
    tx.recentBlockhash = (await erProvider.connection.getLatestBlockhash()).blockhash;
    tx = await erProvider.wallet.signTransaction(tx);
    await erProvider.sendAndConfirm(tx, [], { skipPreflight: true, commitment: "confirmed" });

    // Wait for a few crank ticks (100ms interval).
    await new Promise((r) => setTimeout(r, 2500));

    const erProgram = new Program<Sentinel>(program.idl, erProvider);
    const guard = await erProgram.account.guardConfig.fetch(guardPDA);
    console.log("   guard.lastPrice =", guard.lastPrice.toString());
    console.log("   guard.triggered =", guard.triggered);
    assert.equal(guard.triggered, true, "crank should have tripped the guard with no server");
  });

  it("commit the triggered guard back to L1 (permissionless)", async () => {
    let tx = await program.methods
      .commitGuard()
      .accounts({ payer: erProvider.wallet.publicKey, guard: guardPDA })
      .transaction();
    tx.feePayer = erProvider.wallet.publicKey;
    tx.recentBlockhash = (await erProvider.connection.getLatestBlockhash()).blockhash;
    tx = await erProvider.wallet.signTransaction(tx);
    await erProvider.sendAndConfirm(tx, [], { skipPreflight: true, commitment: "confirmed" });

    await new Promise((r) => setTimeout(r, 2000));
    const guard = await program.account.guardConfig.fetch(guardPDA);
    assert.equal(guard.triggered, true, "L1 should now see the triggered guard");
    console.log("   L1 guard.triggered =", guard.triggered, "→ ready for execute_protection");
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
