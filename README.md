# 🛡️ Sentinel — The On-Chain Keeper for Flash Trade

**A non-custodial liquidation & stop-loss guardian, powered by MagicBlock Ephemeral Rollups.**

> MagicBlock BLITZ V5 · Theme: Trading · Built with Flash Trade (1.5× prize track)

---

## The pain point

Every serious perp trader uses stop-losses and liquidation protection. On-chain, those
orders **don't run on-chain** — they run on a centralized keeper bot:

- If the operator's server goes down, your stop never fires and you get liquidated.
- You either hand the bot the keys to your funds, or you babysit the position yourself.
- "Set a stop and walk away" on a DEX today means *trusting someone's server*.

Base Solana can't fix this alone: 400ms blocks and a per-tick fee make a truly on-chain
keeper that watches the price every moment economically and technically impossible.

## The insight

MagicBlock Ephemeral Rollups give you two primitives that change this:

- **Scheduled cranks** — a program instruction that the rollup runs automatically every
  few milliseconds, with no client transaction and no server. *A trustless keeper.*
- **Sub-10ms gasless execution** on delegated state — so watching the price continuously
  costs nothing.

Sentinel puts the **monitoring and the protect-or-not decision** — the part that needs a
24/7 keeper today — entirely on-chain in the rollup. The chain itself is the keeper.

## How it works

```
                         BASE LAYER (Solana)                         EPHEMERAL ROLLUP
  ┌────────────────────────────────────────────┐        ┌──────────────────────────────┐
  │ 1. initialize_vault   vault PDA = position  │        │                              │
  │                       owner on Flash        │        │                              │
  │ 2. register_guard     rule + price feed     │        │                              │
  │ 3. delegate_guard ───────────────────────────────►   │  guard + price_feed live     │
  │                                              │        │  here now                    │
  │                                              │        │ 4. schedule_monitor (crank)  │
  │                                              │        │ 5. push_price  (Pyth Lazer)  │
  │                                              │        │ 6. evaluate  ── every tick,  │
  │                                              │        │    gasless, NO SERVER →      │
  │                                              │        │    sets `triggered` when the │
  │                                              │        │    stop is hit               │
  │ 8. execute_protection  ◄── 7. commit_guard ──────────│  commit + undelegate         │
  │    permissionless CPI → Flash close_position │        │                              │
  │    signed by the vault PDA                   │        └──────────────────────────────┘
  └────────────────────────────────────────────┘
```

1. **`open_protected_position`** — the trader funds a data-less vault PDA and opens a Flash
   position *through* Sentinel; the vault becomes the position owner, so Sentinel can sign
   the protective close itself — without ever holding the trader's wallet key.
2. **`register_guard`** — stores the rule (stop price / direction) and creates a price
   feed account.
3. **`delegate_guard`** — delegates the guard + price feed to the Ephemeral Rollup.
4. **`schedule_monitor`** — schedules the `evaluate` crank. *After this single tx, no
   client and no server are involved.*
5. **`push_price`** — Pyth Lazer (sub-ms) pushes prices into the rollup, gaslessly. It
   can only write a number; it has no power to close positions, so it is not a trusted
   keeper.
6. **`evaluate`** — the crank handler the rollup runs every tick. Reads the price, flips
   `triggered` the instant the stop is crossed.
7. **`commit_guard`** — permissionless; commits the triggered guard back to L1.
8. **`execute_protection`** — permissionless; CPIs Flash `close_position`, signed by the
   vault PDA. The submitter has **zero discretion** — the program checks `triggered` and
   the price; it is the keeper. Anyone (a stateless relayer, the UI, you) can poke it.

### Why this is honest about the architecture

The MagicBlock crank runs *inside the rollup* and can only touch *delegated* accounts;
Flash's accounts live on the base layer, so the crank cannot CPI Flash directly. So
Sentinel splits cleanly: **the trustless, always-on part (monitor + decide) is on-chain in
the rollup with no server**; settlement is a single discretion-free base-layer transaction.
That is the genuinely-new capability — a stop-loss whose decision-maker is the chain, not
a bot.

## Why it needs Ephemeral Rollups (the "impossible without ER" claim)

| | Base Solana | Centralized keeper | **Sentinel on ER** |
|---|---|---|---|
| Watches price continuously | ✗ 400ms blocks | ✓ (their server) | ✓ rollup crank, sub-10ms |
| Cost to monitor | fee per tick | their cost | **gasless** |
| Who can close your position | — | the operator (custodial) | **only the program** |
| Survives a server going down | — | ✗ | ✓ no server exists |
| Non-custodial | — | usually ✗ | ✓ vault PDA, scoped |

## Program instructions

| Instruction | Domain | Caller | Purpose |
|---|---|---|---|
| `open_protected_position` | base | trader | CPI Flash `open_position`; vault PDA becomes the position owner |
| `register_guard` | base | trader | store rule (stop / take-profit / **trailing**) + create price feed |
| `delegate_guard` | base | trader | delegate guard + feed to the rollup |
| `schedule_monitor` | rollup | trader | schedule the `evaluate` crank |
| `push_price` | rollup | oracle | feed prices (Pyth Lazer / demo pusher) |
| `evaluate` | rollup | **crank** | ratchet trailing stops + flip `triggered` when the rule trips |
| `commit_guard` | rollup | anyone | commit + undelegate the triggered guard |
| `execute_protection` | base | anyone | CPI Flash `close_position` / `decrease_position` (ladder) / `add_collateral`; enforces the anti-MEV settle-lock; pays the keeper bounty |
| `execute_entry` | base | anyone | fill a limit-entry: CPI Flash `open_position` via vault PDA, then auto-arm the bracket stop/TP |
| `init_portfolio` / `enforce_drawdown` | base | trader / anyone | portfolio drawdown guard: trip every position if aggregate equity breaches the threshold |
| `push_price_from_pyth` | rollup | oracle | decode a real Pyth `PriceUpdateV2` into the feed (Pyth-Lazer adapter) |
| `cancel_guard` | base | trader | cancel a guard, reclaim guard + feed rent (non-custodial) |
| `withdraw_vault` | base | trader | drain the vault PDA back to the wallet (non-custodial exit) |
| `publish_strategy` / `follow_strategy` | base | leader / follower | copy-trading: publish a template, followers instantiate guards sized to their own entry |
| `init_grid` / `grid_step` / `stop_grid` | base / **crank** / base | trader | autonomous grid + DCA bot: the crank computes rungs on-chain every tick |
| `delegate_grid` / `schedule_grid` | base / rollup | trader | delegate + schedule the grid crank |

`register_guard` is **session-key aware**: the `authority` (wallet) owns the vault/guard,
but a scoped **session key** may sign (`session_token` + `session_auth_or`) — arm/manage
guards without the wallet online, non-custodially.

### Rule types & actions (the order engine)

- **PriceBelow / PriceAbove** — stop-loss / take-profit (per side).
- **OCO bracket** — one guard with both a stop *and* a take-profit (`tp_price`); first to cross fires.
- **TrailingStop** — the crank ratchets the stop up to `price − trail_distance` as price rises
  (never down), fires on reversal. Continuous on-chain trailing, no server.
- **Breakeven** — once `price ≥ entry + breakeven_offset`, the crank moves the stop to entry.
- **Time exit** — fires when the feed timestamp passes `expiry_ts`.
- **Action `AddMargin`** (liquidation defense) — on trip, CPI Flash `add_collateral` to *keep the
  position alive* instead of closing.
- **Multi-position** — one vault holds many guards (keyed by `guard_id`) — a protected portfolio.
- **Limit-entry orders** — the crank *opens* a position when price crosses the entry (`execute_entry`).
- **Volatility-scaled trailing** — the crank sizes the trail to realized vol from an on-chain price ring buffer.
- **TP-ladder scale-out** — partial closes per rung (`decrease_position`), re-arming each time.
- **Incentivized keepers** — the vault pays a `keeper_bounty` to whoever lands settlement.
- **Portfolio drawdown guard** — `enforce_drawdown` closes every position if aggregate equity falls past a threshold.
- **Copy-trading marketplace** — publish a strategy (offset template + follow fee); followers instantiate sized guards.
- **Bracket orders** — a limit entry that, the moment the crank fills it, auto-arms its own protective
  stop (`bracket_stop`) and take-profit: `execute_entry` flips the guard from `Entry` to `Protect`,
  re-points the trigger at the stop, and re-activates it — entry → protection in one armed object, no
  second transaction.
- **Anti-MEV settle-lock** — on trip, the crank sets `settle_after_ts = now + settle_delay + jitter`,
  where the jitter is derived deterministically on-chain from `price`, `ts`, and `guard_id`.
  `execute_protection` / `execute_entry` reject any settle before that timestamp, so the protective
  close lands in an unpredictable window instead of a front-runnable fixed slot.

All proven on a local validator (15 tests green): `sentinel-orders.ts` (OCO/breakeven/liq-defense 3/3),
`sentinel-trailing.ts` (1/1), `sentinel-copytrade.ts` (1/1), `sentinel-grid.ts` (grid+DCA 2/2),
`sentinel-settlement-local.ts` (3/3), `sentinel-round2.ts` (keeper-bounty/limit-entry/ladder 3/3),
`sentinel-round3.ts` (bracket-on-fill + anti-MEV settle-lock 2/2).

## Off-chain operators (the keeper network)

The on-chain crank decides; permissionless off-chain bots execute. Both are standalone Node
scripts (run with `npx ts-mocha -p ./tsconfig.json -t 0 scripts/<file>.ts`):
- **`scripts/keeper.ts`** — watches for tripped guards and lands settlement (`execute_protection` /
  `execute_entry`), earning each guard's `keeper_bounty`. Anyone can run it; the program is the
  sole authority, so keepers have zero discretion. Run against a cluster without legacy-layout
  accounts (a fresh local validator or devnet).
- **`scripts/notifier.ts`** — fires Telegram/webhook alerts when a guard trips or settles.

> The **vault** is a data-less PDA at `[b"vault", trader]`. It owns the Flash position and
> signs the open/close CPIs via `invoke_signed` — and because it carries no account data it
> can also be the System `create_account` payer for the position (a data-carrying account
> can't). The trader funds it with a SOL deposit; all metadata lives in `GuardConfig`.

## What's proven (live)

- **Monitoring half — devnet, MagicBlock devnet ER** (`tests/sentinel-er-flow.ts`, 6/6):
  after `schedule_monitor`, the crank flips `triggered` on a price crash with **no server
  and no per-tick transaction**, then commits the verdict to L1. Sentinel is deployed at
  `DhQechQHWUwhtDfVCDa5oBjjeq955iB8YMNrH5TrTBPF`.
- **Settlement half — local validator** (`tests/sentinel-settlement-local.ts`, 3/3): the
  vault opens a position via CPI → guard trips → `execute_protection` closes it via a
  vault-PDA-signed CPI; the position account is provably gone afterward.
- **Trailing stop** (`tests/sentinel-trailing.ts`, 1/1): the crank ratchets the stop up
  as price rises and fires on reversal — the continuous on-chain trailing only an ER can do.

## Repo layout

```
sentinel/
  programs/sentinel/src/
    lib.rs                      program entry, instruction routing
    state.rs                    GuardConfig, PriceFeed, RuleType (vault is a data-less PDA)
    error.rs                    SentinelError
    constants.rs                seeds + Flash program id
    instructions/
      open_protected_position.rs  hand-built Flash open_position CPI (vault = owner)
      register_guard.rs
      delegate_guard.rs           #[delegate] guard + price feed → ER
      schedule_monitor.rs         ScheduleTask CPI → evaluate crank
      push_price.rs
      evaluate.rs                 the crank handler
      commit_guard.rs             #[commit] commit_and_undelegate
      execute_protection.rs       hand-built Flash close_position CPI (vault signs)
  programs/flash_stub/            interface-faithful Flash open/close harness (devnet/local demo)
  tests/                          sentinel-er-flow.ts, sentinel-settlement-local.ts, sentinel-settlement-slice.ts
reference/                        cloned: flash-perpetuals, ER SDK, engine examples
```

## Demo

Split screen: a price feed crashing, and two identical Flash positions — one unprotected
(liquidated), one Sentinel-guarded. As the price hits the stop, the guarded position
auto-closes a moment later. Then we show the on-chain crank transaction that did it **with
no server process running**.

> Stop-losses on every other on-chain venue trust a centralized bot. Sentinel's is the
> chain itself.

## Status & honesty notes

- The settlement CPI is wired to the published `flash-trade/flash-perpetuals` interface
  (`open_position` / `close_position` — discriminators, account order, and params verified
  against source; the reference program is live on devnet at
  `Bmr31xzZYYVUdoHmAJL1DAp2anaitW8Tw9YfASS94MKJ`, production Flash at `FLASH6Lo…`).
- The demo settles against `flash_stub`, an **interface-faithful harness** (identical
  instruction names → identical discriminators, identical account order/params), because
  the source program needs an old toolchain (anchor 0.28 / solana 1.16) to build and the
  live deployment can't be freshly bootstrapped without admin/IDL access. Sentinel's CPI is
  byte-identical against the stub and the real program — only the venue program id differs.
- Price-into-rollup uses a Sentinel price feed fed by Pyth Lazer in production; the demo
  uses a price pusher to drive the crash. The feed is an oracle, not a keeper — it cannot
  move funds.
- "No server" is scoped to the monitoring + decision (the ER crank). Settlement still needs
  *someone* to submit `commit_guard` + `execute_protection`, but they have zero discretion
  (the program checks `triggered`/price and is the sole authority) — a stateless relayer or
  one button click.
- **Anti-MEV is shipped as a deterministic time-lock + on-chain jitter**, not VRF. The jitter
  seed is `price ^ (ts·2654435761) ^ (guard_id·40503)` — cheap, no extra accounts, no cross-program
  coupling, and it already removes the fixed-slot front-run target. Verifiable randomness
  (`ephemeral-vrf-sdk`'s request/callback) is the documented upgrade: it would make the delay
  unpredictable even to an observer who can reconstruct the seed, at the cost of a VRF round-trip
  inside the ER. We chose the robust, self-contained version for the weekend and call the VRF
  swap out honestly rather than ship a fragile dependency.
- Vision (not in the weekend scope): VRF-backed jitter, TWAP/OCO ladders, and a full algo-order
  terminal — all the same pattern, more rules.

## Built with

- **MagicBlock Ephemeral Rollups** — `ephemeral-rollups-sdk` (delegate/commit + scheduled
  cranks via `magicblock-magic-program-api`)
- **Flash Trade** — `flash-trade/flash-perpetuals` (`close_position` CPI)
- **Pyth Lazer** — sub-ms price feeds into the rollup
- Anchor / Solana
