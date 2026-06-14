/**
 * Sentinel keeper bot — the permissionless settlement layer.
 *
 * The on-chain crank decides *when* a guard fires; this bot lands the settlement
 * transaction (close / fill / add-margin) and earns the guard's `keeper_bounty`.
 * Anyone can run it — it has no special authority; the program is the sole
 * decision-maker. Running more keepers just makes settlement faster + more robust.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
 *     npx ts-mocha -p ./tsconfig.json -t 0 scripts/keeper.ts     # (or compile + node)
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import { Sentinel } from "../target/types/sentinel";

const VENUE = new web3.PublicKey("3pueX18BCYp8D2qNbdTrDeLDhP25uuEHe7HG2DCfqd8F");
const DUMMY = web3.Keypair.generate().publicKey;
const SYS = web3.SystemProgram.programId;
const enc = new TextEncoder();
const m = (pk: web3.PublicKey, w: boolean) => ({ pubkey: pk, isSigner: false, isWritable: w });

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Sentinel as Program<Sentinel>;
  const me = provider.wallet.publicKey;
  console.log("⛏  Sentinel keeper:", me.toBase58());

  const GUARD_LEN = 315; // current GuardConfig size — filters out stale-layout accounts
  const settled = new Set<string>();
  for (;;) {
    try {
      const raw = await provider.connection.getProgramAccounts(program.programId, { filters: [{ dataSize: GUARD_LEN }] });
      const guards = raw
        .map((r) => { try { return { publicKey: r.pubkey, account: program.coder.accounts.decode("GuardConfig", r.account.data) as any }; } catch { return null; } })
        .filter(Boolean) as { publicKey: web3.PublicKey; account: any }[];
      for (const { publicKey, account } of guards) {
        const g: any = account;
        const key = publicKey.toBase58();
        if (!g.triggered || g.executed || settled.has(key)) continue;

        const vault = g.vault as web3.PublicKey;
        const position = web3.PublicKey.findProgramAddressSync([enc.encode("position"), vault.toBuffer()], VENUE)[0];
        const isEntry = !!g.kind?.entry;
        const open = [m(DUMMY, true), m(DUMMY, false), m(DUMMY, false), m(g.market, true), m(position, true), m(DUMMY, true), m(DUMMY, false), m(DUMMY, true), m(DUMMY, false), m(DUMMY, true), m(SYS, false), m(SYS, false)];
        const close = open.slice(0, 11);

        try {
          if (isEntry) {
            await program.methods.executeEntry().accounts({ guard: publicKey, vault, flashProgram: VENUE, cranker: me, systemProgram: SYS }).remainingAccounts(open).rpc({ skipPreflight: true });
            console.log(`✅ filled limit entry ${key.slice(0, 8)} (+bounty)`);
          } else {
            await program.methods.executeProtection().accounts({ guard: publicKey, vault, flashProgram: VENUE, cranker: me, systemProgram: SYS }).remainingAccounts(close).rpc({ skipPreflight: true });
            console.log(`✅ settled protection ${key.slice(0, 8)} (+bounty)`);
          }
          // ladders re-arm (triggered=false); only mark spent when fully executed.
          settled.add(key);
        } catch (e: any) {
          console.error(`   settle ${key.slice(0, 8)} failed:`, e?.message ?? e);
        }
      }
    } catch (e) {
      console.error(e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
main();
