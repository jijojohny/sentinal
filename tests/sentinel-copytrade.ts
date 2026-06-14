/**
 * Sentinel — copy-trading vaults (Phase 5).
 * A leader publishes a strategy (offsets from entry); a follower instantiates
 * their own guard from it, sized to the follower's own entry price. Non-custodial.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";
import { assert } from "chai";

describe("sentinel-copytrade", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sentinel = anchor.workspace.Sentinel as Program<Sentinel>;
  const pid = sentinel.programId;
  const pda = (s: (Buffer | Uint8Array)[]) => web3.PublicKey.findProgramAddressSync(s, pid)[0];
  const gid = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);

  const leaderKp = web3.Keypair.generate();
  const followerKp = web3.Keypair.generate();
  const market = web3.Keypair.generate().publicKey;
  const SID = 0;
  const strategy = pda([Buffer.from("strategy"), leaderKp.publicKey.toBuffer(), gid(SID)]);
  const fVault = pda([Buffer.from("vault"), followerKp.publicKey.toBuffer()]);
  const fGuard = pda([Buffer.from("guard"), fVault.toBuffer(), gid(0)]);
  const fPrice = pda([Buffer.from("price"), fVault.toBuffer(), gid(0)]);

  before(async () => {
    for (const kp of [leaderKp, followerKp]) {
      await provider.sendAndConfirm(
        new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: kp.publicKey, lamports: 0.5 * web3.LAMPORTS_PER_SOL })),
        [], { commitment: "confirmed" },
      );
    }
  });

  it("leader publishes, follower instantiates a guard sized to its own entry", async () => {
    await sentinel.methods
      .publishStrategy({ strategyId: new BN(SID), rule: { priceBelow: {} }, action: { close: {} }, side: 1, stopOffset: new BN(5_000_000), tpOffset: new BN(10_000_000), trailDistance: new BN(0), breakevenOffset: new BN(0), marginAmount: new BN(0), feeLamports: new BN(0) })
      .accounts({ strategy, leader: leaderKp.publicKey })
      .signers([leaderKp]).rpc({ commitment: "confirmed" });

    // Follower's entry is 100 → trigger 95, tp 110 (derived from the strategy offsets).
    await sentinel.methods
      .followStrategy({ guardId: new BN(0), market, initialPrice: new BN(100_000_000), closePriceLimit: new BN(94_000_000) })
      .accounts({ strategy, vault: fVault, guard: fGuard, priceFeed: fPrice, follower: followerKp.publicKey, leader: leaderKp.publicKey })
      .signers([followerKp]).rpc({ commitment: "confirmed" });

    const g = await sentinel.account.guardConfig.fetch(fGuard);
    assert.equal(g.triggerPrice.toNumber(), 95_000_000);
    assert.equal(g.tpPrice.toNumber(), 110_000_000);
    const s = await sentinel.account.strategy.fetch(strategy);
    assert.equal(s.followers, 1);
    console.log("   follower guard: stop", g.triggerPrice.toNumber() / 1e6, "tp", g.tpPrice.toNumber() / 1e6, "| strategy followers:", s.followers);
  });

  after(() => setTimeout(() => process.exit(0), 100));
});
