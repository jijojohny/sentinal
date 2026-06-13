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

1. **`initialize_vault`** — creates a vault PDA. The vault *is* the owner of the Flash
   position, so Sentinel can sign the protective close itself — without ever holding the
   trader's wallet key.
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
| `initialize_vault` | base | trader | create vault PDA (the Flash position owner) |
| `register_guard` | base | trader | store rule + create price feed |
| `delegate_guard` | base | trader | delegate guard + feed to the rollup |
| `schedule_monitor` | rollup | trader | schedule the `evaluate` crank |
| `push_price` | rollup | oracle | feed prices (Pyth Lazer / demo pusher) |
| `evaluate` | rollup | **crank** | flip `triggered` when the rule trips |
| `commit_guard` | rollup | anyone | commit + undelegate the triggered guard |
| `execute_protection` | base | anyone | CPI Flash `close_position` via vault PDA |

## Repo layout

```
sentinel/
  programs/sentinel/src/
    lib.rs                      program entry, instruction routing
    state.rs                    Vault, GuardConfig, PriceFeed, RuleType
    error.rs                    SentinelError
    constants.rs                seeds + Flash program id
    instructions/
      initialize_vault.rs
      register_guard.rs
      delegate_guard.rs         #[delegate] guard + price feed → ER
      schedule_monitor.rs       ScheduleTask CPI → evaluate crank
      push_price.rs
      evaluate.rs               the crank handler
      commit_guard.rs           #[commit] commit_and_undelegate
      execute_protection.rs     hand-built Flash close_position CPI
reference/                      cloned: flash-perpetuals, ER SDK, engine examples
```

## Demo

Split screen: a price feed crashing, and two identical Flash positions — one unprotected
(liquidated), one Sentinel-guarded. As the price hits the stop, the guarded position
auto-closes a moment later. Then we show the on-chain crank transaction that did it **with
no server process running**.

> Stop-losses on every other on-chain venue trust a centralized bot. Sentinel's is the
> chain itself.

## Status & honesty notes

- Built against the published `flash-trade/flash-perpetuals` program; the demo runs on a
  local validator with the Flash program + a test pool (using Flash's own test setup
  instructions), since that is reproducible without a live devnet pool.
- Price-into-rollup uses a Sentinel price feed fed by Pyth Lazer in production; the demo
  uses a price pusher to drive the crash. The feed is an oracle, not a keeper — it cannot
  move funds.
- Vision (not in the weekend scope): take-profit ladders, trailing stops, TWAP/OCO, and a
  full algo-order terminal — all the same pattern, more rules.

## Built with

- **MagicBlock Ephemeral Rollups** — `ephemeral-rollups-sdk` (delegate/commit + scheduled
  cranks via `magicblock-magic-program-api`)
- **Flash Trade** — `flash-trade/flash-perpetuals` (`close_position` CPI)
- **Pyth Lazer** — sub-ms price feeds into the rollup
- Anchor / Solana
