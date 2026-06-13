# Running the Sentinel demo

Two ways to see it. The **local** path works end to end right now and is what you record.
The **devnet** path adds the real Ephemeral Rollup crank (needs ~3.5 devnet SOL).

---

## A. Local demo (full open → crash → auto-close) — recordable now

Four terminals (or use the helper script below).

```bash
# 1. local validator
cd sentinel
solana-test-validator --reset --ledger test-ledger

# 2. build + deploy both programs locally
anchor build
solana airdrop 100 -u localhost
solana program deploy target/deploy/sentinel.so   --program-id target/deploy/sentinel-keypair.json   -u localhost
solana program deploy target/deploy/flash_stub.so --program-id target/deploy/flash_stub-keypair.json -u localhost

# 3. web UI
cd app && npm install && npm run dev        # → http://localhost:5173

# 4. run the driver (writes app/src/demo-config.json, paces the crash)
cd sentinel
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 600000 scripts/demo-driver.ts
```

Open http://localhost:5173 **before** step 4, then start the driver and record:
the price line falls, the unprotected position liquidates, and the Sentinel-guarded
position **auto-closes at the stop** — the position account is provably gone afterward.

### What the demo proves
- `open_protected_position` — the vault PDA opens a Flash-interface position via CPI.
- the crank tick flips `triggered` when the price crosses the stop.
- `execute_protection` — permissionless, vault-signed CPI closes the position. Non-custodial.

> On local there is no Ephemeral Rollup, so the driver calls `evaluate` directly (one
> crank tick). The **autonomous** crank — the rollup running `evaluate` every tick with
> no server — is proven live on devnet (below).

---

## B. Devnet — the autonomous crank, live (no server)

Already passing against MagicBlock's devnet ER:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/sentinel-er-flow.ts
```

Shows: delegate → schedule crank → push a crash price → the crank flips `triggered`
**with no evaluate tx from us** → commit to L1. (Sentinel is deployed at
`DhQechQHWUwhtDfVCDa5oBjjeq955iB8YMNrH5TrTBPF`.)

### Full devnet slice (monitoring + settlement in one environment)
Needs the refactored Sentinel + the stub redeployed to devnet and the wallet funded with
~3.5 devnet SOL (the program upgrade buffer). Fund `EibRsRoMiPD7yndP7YJbZt5Ut19poNqsjs3BvvTQ5rgp`
(faucet.solana.com or any devnet faucet), then:

```bash
anchor build
solana program deploy target/deploy/sentinel.so   --program-id target/deploy/sentinel-keypair.json   -u d
solana program deploy target/deploy/flash_stub.so --program-id target/deploy/flash_stub-keypair.json -u d   # if not already
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/sentinel-settlement-slice.ts
```

This runs the whole thing — vault opens → ER crank trips on the crash → commit → permissionless `execute_protection` closes the real position — on devnet + the live ER.
