use anchor_lang::prelude::*;

/// The per-trader vault is a *data-less* PDA at [VAULT_SEED, trader]. It owns the
/// Flash position and signs the open/close CPIs via invoke_signed — but holds no
/// account data, so it can also be the System `create_account` payer for the
/// position (a data-carrying account cannot). It simply holds lamports (the
/// trader's deposit) and is a deterministic signing authority. Metadata lives in
/// GuardConfig, so there is no Vault account struct.

/// The rule a guard enforces.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RuleType {
    /// Long stop-loss / short take-profit: fire when price <= trigger_price.
    PriceBelow,
    /// Long take-profit / short stop-loss: fire when price >= trigger_price.
    PriceAbove,
    /// Trailing stop: the crank ratchets `trigger_price` up to `price - trail_distance`
    /// as the price rises (never down), then fires when price <= trigger_price. The
    /// ratchet runs every tick, gaslessly, on-chain — the killer ER feature.
    TrailingStop,
}

/// What the guard does when it trips.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActionType {
    /// Close the position (stop-loss / take-profit / trailing).
    Close,
    /// Liquidation defense: add collateral to keep the position alive (re-arms).
    AddMargin,
}

/// Whether a guard protects an existing position or is a pending limit ENTRY.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum GuardKind {
    /// Watches an open position and settles via close/add-margin.
    Protect,
    /// Armed but position-less: opens a position when the price crosses the trigger.
    Entry,
}

/// Why a guard tripped (telemetry for the UI / events).
/// 0 = none, 1 = stop, 2 = take-profit, 3 = time-exit.
pub const TRIP_NONE: u8 = 0;
pub const TRIP_STOP: u8 = 1;
pub const TRIP_TP: u8 = 2;
pub const TRIP_TIME: u8 = 3;

/// A guard: the rule + everything needed to rebuild the Flash CPI. This is the
/// account delegated to the Ephemeral Rollup and ticked by the on-chain crank —
/// no server watches the price, the rollup does. One vault can own many guards
/// (keyed by `guard_id`) → a portfolio of protected positions.
#[account]
pub struct GuardConfig {
    pub vault: Pubkey,  // owning vault PDA (also the Flash position owner)
    pub owner: Pubkey,  // trader
    pub market: Pubkey, // Flash pool key, identifies the market
    pub guard_id: u64,  // which guard within this vault (multi-position registry)
    pub side: u8,       // Flash position side byte (0 = None, 1 = Long, 2 = Short)
    pub rule: RuleType,
    pub action: ActionType, // Close (default) or AddMargin (liquidation defense)
    pub entry_price: u64,    // price at registration (breakeven reference)
    pub trigger_price: u64,  // stop level (ratchets for trailing / breakeven)
    pub trail_distance: u64, // TrailingStop: how far below the high the stop trails
    pub tp_price: u64,       // OCO take-profit level (0 = none)
    pub breakeven_offset: u64, // once price ≥ entry + offset, move stop to entry (0 = off)
    pub expiry_ts: i64,      // time-based exit: trip when feed ts ≥ this (0 = none)
    pub margin_amount: u64,  // AddMargin: collateral to add on trip
    pub close_price_limit: u64, // slippage bound passed to Flash close/add
    pub last_price: u64,     // most recent price seen by the crank
    pub high_water: u64,     // highest price seen (trailing telemetry)
    pub triggered: bool,     // set by the crank when the rule trips
    pub executed: bool,      // set by settlement after the Flash CPI
    pub active: bool,        // false once executed (Close) or cancelled
    pub breakeven_armed: bool, // breakeven stop has been moved to entry
    pub trip_reason: u8,     // TRIP_* — why it tripped
    pub kind: GuardKind,        // Protect (exit) or Entry (limit order)
    pub keeper_bounty: u64,     // lamports paid to whoever lands settlement
    pub vol_k: u64,             // bps: trail = vol * vol_k / 10000 (0 = off → fixed trail)
    pub entry_size: u64,        // Entry kind: size to open on fill / total size for ladders
    pub entry_collateral: u64,  // Entry kind: collateral to open with
    pub tp_ladder: [u64; 3],    // scale-out take-profit rungs (ascending; 0 = unused)
    pub ladder_done: u8,        // rungs already closed
    pub bracket_stop: u64,      // Entry kind: stop to auto-arm on fill (bracket; tp_price = bracket TP)
    pub settle_delay: i64,      // anti-MEV: seconds settlement is locked after a trip (0 = off)
    pub settle_after_ts: i64,   // set on trip = ts + settle_delay + jitter; settlement requires now ≥ this
    pub bump: u8,
}

impl GuardConfig {
    pub const LEN: usize = 8 + 96 + 8 + 4 + 8 * 13 + 8 + 4 + 1 + 24 + 1 + 24 + 32;

    /// Number of configured ladder rungs.
    pub fn ladder_rungs(&self) -> u8 {
        self.tp_ladder.iter().filter(|&&x| x > 0).count() as u8
    }

    /// Per-tick maintenance: track the high, ratchet a trailing stop up, and arm a
    /// breakeven stop. Runs every crank tick — fully on-chain, no server.
    pub fn ratchet(&mut self, price: u64) {
        if price > self.high_water {
            self.high_water = price;
        }
        // Trailing stop: raise the stop to price - trail (never lower).
        if matches!(self.rule, RuleType::TrailingStop) && self.trail_distance > 0 {
            let candidate = price.saturating_sub(self.trail_distance);
            if candidate > self.trigger_price {
                self.trigger_price = candidate;
            }
        }
        // Breakeven: once far enough in profit, move the stop up to entry, once.
        if !self.breakeven_armed
            && self.breakeven_offset > 0
            && price >= self.entry_price.saturating_add(self.breakeven_offset)
        {
            if self.entry_price > self.trigger_price {
                self.trigger_price = self.entry_price;
            }
            self.breakeven_armed = true;
        }
    }

    /// Evaluate every condition against the latest price + feed timestamp.
    /// Returns the TRIP_* reason (0 = not tripped). OCO = a stop with `tp_price` set.
    pub fn trip_reason(&self, price: u64, ts: i64) -> u8 {
        if self.expiry_ts > 0 && ts >= self.expiry_ts {
            return TRIP_TIME;
        }
        // Take-profit side (explicit TP rule, or OCO's tp_price).
        if matches!(self.rule, RuleType::PriceAbove) && price >= self.trigger_price {
            return TRIP_TP;
        }
        if self.tp_price > 0 && price >= self.tp_price {
            return TRIP_TP;
        }
        // Stop side.
        if matches!(self.rule, RuleType::PriceBelow | RuleType::TrailingStop)
            && price <= self.trigger_price
        {
            return TRIP_STOP;
        }
        TRIP_NONE
    }
}

/// Per-vault portfolio risk guard: close ALL positions if aggregate equity drops
/// more than `max_drawdown_bps` from its high-water mark.
#[account]
pub struct PortfolioGuard {
    pub owner: Pubkey,
    pub max_drawdown_bps: u16, // e.g. 2000 = 20%
    pub peak_equity: u64,      // high-water aggregate equity (oracle units)
    pub last_equity: u64,
    pub breached: bool,
    pub bump: u8,
}

impl PortfolioGuard {
    pub const LEN: usize = 8 + 32 + 2 + 8 + 8 + 1 + 1 + 8;
}

/// A published copy-trading strategy: a leader's guard *template* expressed as
/// offsets from entry (so each follower's guard adapts to their own entry price).
#[account]
pub struct Strategy {
    pub leader: Pubkey,
    pub strategy_id: u64,
    pub rule: RuleType,
    pub action: ActionType,
    pub side: u8,
    pub stop_offset: u64,      // trigger = entry - stop_offset
    pub tp_offset: u64,        // tp = entry + tp_offset (0 = none)
    pub trail_distance: u64,
    pub breakeven_offset: u64,
    pub margin_amount: u64,
    pub fee_lamports: u64,     // flat fee a follower pays the leader to copy
    pub followers: u32,
    pub bump: u8,
}

impl Strategy {
    pub const LEN: usize = 8 + 32 + 8 + 1 + 1 + 1 + 8 * 6 + 4 + 1 + 8;
}

/// An autonomous grid / DCA bot config. Delegated to the ER and ticked by a
/// scheduled crank: every tick it computes which grid level the price is in and
/// records a "fill" when the level changes — the bot's decisions run entirely
/// on-chain in the rollup, gaslessly, with no server. (Rung execution on Flash
/// reuses the vault CPI path, same as `execute_protection`.)
#[account]
pub struct GridConfig {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub grid_id: u64,
    pub lower: u64,           // bottom of the grid (price units)
    pub upper: u64,           // top of the grid
    pub levels: u8,           // number of grid lines (≥2)
    pub order_size: u64,      // size per rung
    pub mode: u8,             // 0 = grid (level-cross), 1 = DCA (time-spaced)
    pub interval_ticks: u32,  // DCA: act every N ticks
    pub tick_count: u32,      // ticks observed
    pub last_level: i16,      // last grid level the price was in (-1 = none yet)
    pub last_price: u64,
    pub fills: u32,           // rungs executed (telemetry)
    pub active: bool,
    pub bump: u8,
}

impl GridConfig {
    pub const LEN: usize = 8 + 32 * 3 + 8 + 8 + 8 + 1 + 8 + 1 + 4 + 4 + 2 + 8 + 4 + 1 + 1 + 8;

    /// Which grid band [0, levels-1] the price falls in. Saturates to the ends.
    pub fn level_of(&self, price: u64) -> i16 {
        if self.levels < 2 || self.upper <= self.lower {
            return 0;
        }
        if price <= self.lower {
            return 0;
        }
        if price >= self.upper {
            return (self.levels - 1) as i16;
        }
        let span = self.upper - self.lower;
        let step = span / (self.levels as u64 - 1);
        if step == 0 {
            return 0;
        }
        ((price - self.lower) / step) as i16
    }
}

/// A lightweight price feed account, owned by Sentinel and delegated to the ER
/// alongside the guard. In production this is fed by Pyth Lazer (sub-ms updates);
/// for the demo a price-pusher writes into it gaslessly inside the rollup.
#[account]
pub struct PriceFeed {
    pub market: Pubkey,
    pub price: u64,
    pub ts: i64,
    pub samples: [u64; 8], // ring buffer of recent prices (for on-chain volatility)
    pub head: u8,          // next write index into `samples`
    pub filled: u8,        // how many samples are valid (0..=8)
    pub bump: u8,
}

impl PriceFeed {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 * 8 + 1 + 1 + 1 + 8;

    /// Append a price into the ring buffer.
    pub fn record(&mut self, price: u64) {
        self.samples[self.head as usize] = price;
        self.head = (self.head + 1) % 8;
        if self.filled < 8 {
            self.filled += 1;
        }
    }

    /// Crude realized volatility: mean absolute tick-to-tick change over the buffer.
    pub fn volatility(&self) -> u64 {
        let n = self.filled as usize;
        if n < 2 {
            return 0;
        }
        // Reconstruct chronological order from the ring.
        let mut sum: u128 = 0;
        let mut prev: Option<u64> = None;
        for i in 0..n {
            let idx = (self.head as usize + 8 - n + i) % 8;
            let p = self.samples[idx];
            if let Some(pv) = prev {
                sum += (p.max(pv) - p.min(pv)) as u128;
            }
            prev = Some(p);
        }
        (sum / (n as u128 - 1)) as u64
    }
}
