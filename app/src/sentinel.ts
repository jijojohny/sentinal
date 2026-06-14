import { AnchorProvider, Program, BN, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import sentinelIdl from "./idl/sentinel.json";
import {
  SENTINEL_PROGRAM_ID, VENUE_PROGRAM_ID, vaultPda, guardPda, pricePda, positionPda, toUnits,
  strategyPda, gridPda, gridFeedPda, portfolioPda,
} from "./config";

// Stand-in accounts for the venue (flash_stub) CPI. Against real Flash these are
// the pool/custody/oracle accounts; the harness ignores them, so one dummy works.
const DUMMY = Keypair.generate().publicKey;
const MARKET = new PublicKey("So11111111111111111111111111111111111111112"); // SOL — the market label

type WalletLike = {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
};

export type Rule = "stop" | "takeProfit" | "trailing";
export type ProtectParams = {
  rule: Rule;
  addMargin: boolean;
  entry: number;
  triggerPrice: number;
  tpPrice: number;      // 0 = none
  trailDistance: number;
  breakevenOffset: number;
  marginAmount: number; // for add-margin action
  sizeUsd: number;
  collateralUsd: number;
  keeperBounty?: number; // SOL tip to the keeper that settles
  volK?: number;         // vol-scaled trail factor (bps); 0 = off
  tpLadder?: number[];   // up to 3 scale-out prices; 0 = unused
  expiry?: number;       // unix seconds for time-exit; 0 = off
  bracketStop?: number;  // limit-entry: stop auto-armed on fill; 0 = none
  settleDelay?: number;  // anti-MEV settle-lock seconds; 0 = off
};

const meta = (pk: PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });
const SYS = SystemProgram.programId;
const openRemaining = (position: PublicKey) => [
  meta(DUMMY, true), meta(DUMMY, false), meta(DUMMY, false), meta(MARKET, true), meta(position, true),
  meta(DUMMY, true), meta(DUMMY, false), meta(DUMMY, true), meta(DUMMY, false), meta(DUMMY, true), meta(SYS, false), meta(SYS, false),
];

export function makeClient(connection: Connection, wallet: WalletLike, erConnection?: Connection) {
  const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  const program = new Program(sentinelIdl as Idl, provider);
  const owner = wallet.publicKey;
  const vault = vaultPda(owner);

  const ruleEnum = (r: Rule) => (r === "stop" ? { priceBelow: {} } : r === "takeProfit" ? { priceAbove: {} } : { trailingStop: {} });

  return {
    program,
    vault,
    owner,

    /** Open a vault-owned position and arm a guard in one go (base layer). */
    async openAndProtect(p: ProtectParams, guardId = 0) {
      const position = positionPda(vault);
      const guard = guardPda(vault, guardId);
      const price = pricePda(vault, guardId);

      // 1) fund the vault PDA so it can pay the position rent + hold collateral.
      const fund = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: vault, lamports: 0.05 * 1e9 }),
      );
      await provider.sendAndConfirm(fund, []);

      // 2) open the vault-owned position via the venue CPI.
      await program.methods
        .openProtectedPosition({ price: toUnits(p.entry), collateral: toUnits(p.collateralUsd), size: toUnits(p.sizeUsd), side: 1 })
        .accounts({ vault, owner, flashProgram: VENUE_PROGRAM_ID, trader: owner })
        .remainingAccounts(openRemaining(position))
        .rpc();

      // 3) register the guard.
      await program.methods
        .registerGuard({
          guardId: new BN(guardId), market: MARKET, side: 1, rule: ruleEnum(p.rule),
          action: p.addMargin ? { addMargin: {} } : { close: {} },
          kind: { protect: {} },
          triggerPrice: toUnits(p.triggerPrice), trailDistance: toUnits(p.trailDistance),
          tpPrice: toUnits(p.tpPrice), breakevenOffset: toUnits(p.breakevenOffset),
          expiryTs: new BN(p.expiry ?? 0), marginAmount: toUnits(p.marginAmount),
          keeperBounty: new BN(Math.round((p.keeperBounty ?? 0) * 1e9)),
          volK: new BN(p.volK ?? 0),
          entrySize: toUnits(p.sizeUsd), entryCollateral: toUnits(p.collateralUsd),
          tpLadder: (p.tpLadder ?? [0, 0, 0]).map((x) => toUnits(x)),
          bracketStop: new BN(0), settleDelay: new BN(p.settleDelay ?? 0),
          closePriceLimit: toUnits(p.triggerPrice * 0.99),
          initialPrice: toUnits(p.entry),
        })
        .accounts({ authority: owner, vault, guard, priceFeed: price, payer: owner, sessionToken: null })
        .rpc();

      return { guard, price, position };
    },

    /** Place a limit-ENTRY order: arm a position-less guard that the crank fills when
     *  the price crosses the entry. No position is opened now. */
    async placeLimitOrder(p: ProtectParams, guardId = 0) {
      const guard = guardPda(vault, guardId);
      const price = pricePda(vault, guardId);
      await program.methods
        .registerGuard({
          guardId: new BN(guardId), market: MARKET, side: 1, rule: ruleEnum(p.rule), action: { close: {} },
          kind: { entry: {} },
          triggerPrice: toUnits(p.triggerPrice), trailDistance: new BN(0), tpPrice: toUnits(p.tpPrice),
          breakevenOffset: new BN(0), expiryTs: new BN(0), marginAmount: new BN(0),
          keeperBounty: new BN(Math.round((p.keeperBounty ?? 0) * 1e9)), volK: new BN(0),
          entrySize: toUnits(p.sizeUsd), entryCollateral: toUnits(p.collateralUsd),
          tpLadder: [new BN(0), new BN(0), new BN(0)],
          bracketStop: toUnits(p.bracketStop ?? 0), settleDelay: new BN(p.settleDelay ?? 0),
          closePriceLimit: toUnits(p.triggerPrice), initialPrice: toUnits(p.entry),
        })
        .accounts({ authority: owner, vault, guard, priceFeed: price, payer: owner, sessionToken: null })
        .rpc();
      return { guard, price };
    },

    /** Activate live rollup monitoring (delegate + schedule the crank). Needs the ER. */
    async activateMonitoring(guardId = 0) {
      await program.methods.delegateGuard(new BN(guardId)).accounts({ payer: owner }).rpc();
      const erProgram = erConnection ? new Program(sentinelIdl as Idl, new AnchorProvider(erConnection, wallet as any, {})) : program;
      const guard = guardPda(vault, guardId);
      const price = pricePda(vault, guardId);
      const tx = await erProgram.methods
        .scheduleMonitor({ taskId: new BN(Date.now() % 1e9), executionIntervalMillis: new BN(200), iterations: new BN(1000) })
        .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: owner, guard, priceFeed: price, program: SENTINEL_PROGRAM_ID })
        .transaction();
      tx.feePayer = owner;
      tx.recentBlockhash = (await (erConnection ?? connection).getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction(tx);
      await (erConnection ?? connection).sendRawTransaction(signed.serialize(), { skipPreflight: true });
    },

    /** All guards owned by the connected wallet (the dashboard). */
    async listGuards() {
      const all = await program.account.guardConfig.all([
        { memcmp: { offset: 8 + 32, bytes: owner.toBase58() } }, // owner field is 2nd (after vault)
      ]);
      return all.map((a: any) => ({ pubkey: a.publicKey, ...a.account }));
    },

    async cancelGuard(guardId = 0) {
      const guard = guardPda(vault, guardId);
      const price = pricePda(vault, guardId);
      await program.methods.cancelGuard(new BN(guardId)).accounts({ vault, guard, priceFeed: price, trader: owner }).rpc();
    },

    async withdrawVault() {
      await program.methods.withdrawVault().accounts({ vault, trader: owner, systemProgram: SYS }).rpc();
    },

    /** Next free guard_id (so a vault can hold many guards). */
    async nextGuardId() {
      const gs = await this.listGuards();
      const used = new Set(gs.map((g: any) => Number(g.guardId)));
      let i = 0; while (used.has(i)) i++; return i;
    },

    // ----- copy-trading marketplace -----
    async publishStrategy(id: number, p: { stopOffset: number; tpOffset: number; trailDistance: number; feeSol: number }) {
      const strategy = strategyPda(owner, id);
      await program.methods.publishStrategy({
        strategyId: new BN(id), rule: { priceBelow: {} }, action: { close: {} }, side: 1,
        stopOffset: toUnits(p.stopOffset), tpOffset: toUnits(p.tpOffset), trailDistance: toUnits(p.trailDistance),
        breakevenOffset: new BN(0), marginAmount: new BN(0), feeLamports: new BN(Math.round(p.feeSol * 1e9)),
      }).accounts({ strategy, leader: owner }).rpc();
    },
    async listStrategies() {
      const all = await program.account.strategy.all();
      return all.map((a: any) => ({ pubkey: a.publicKey, ...a.account }));
    },
    async followStrategy(leader: PublicKey, strategyId: number, entry: number, guardId: number) {
      const strategy = strategyPda(leader, strategyId);
      await program.methods.followStrategy({ guardId: new BN(guardId), market: MARKET, initialPrice: toUnits(entry), closePriceLimit: toUnits(entry * 0.99) })
        .accounts({ strategy, vault, guard: guardPda(vault, guardId), priceFeed: pricePda(vault, guardId), follower: owner, leader, systemProgram: SYS }).rpc();
    },

    // ----- grid / DCA bot -----
    async initGrid(id: number, p: { lower: number; upper: number; levels: number; sizeUsd: number; mode: number; interval: number; entry: number }) {
      const grid = gridPda(vault, id);
      await program.methods.initGrid({
        gridId: new BN(id), market: MARKET, lower: toUnits(p.lower), upper: toUnits(p.upper), levels: p.levels,
        orderSize: toUnits(p.sizeUsd), mode: p.mode, intervalTicks: p.interval, initialPrice: toUnits(p.entry),
      }).accounts({ vault, grid, gridFeed: gridFeedPda(grid), trader: owner, systemProgram: SYS }).rpc();
    },
    async listGrids() {
      const all = await program.account.gridConfig.all([{ memcmp: { offset: 8 + 32, bytes: owner.toBase58() } }]);
      return all.map((a: any) => ({ pubkey: a.publicKey, ...a.account }));
    },
    async stopGrid(grid: PublicKey) {
      await program.methods.stopGrid().accounts({ grid, owner }).rpc();
    },

    // ----- portfolio drawdown guard -----
    async initPortfolio(maxDrawdownBps: number) {
      await program.methods.initPortfolio(maxDrawdownBps).accounts({ portfolio: portfolioPda(owner), owner, systemProgram: SYS }).rpc();
    },
    async getPortfolio() {
      try { return await program.account.portfolioGuard.fetch(portfolioPda(owner)); } catch { return null; }
    },
  };
}
