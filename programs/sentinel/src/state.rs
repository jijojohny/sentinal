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

/// A guard: the rule + everything needed to rebuild the Flash close CPI.
/// This is the account that gets delegated to the Ephemeral Rollup and ticked
/// by the on-chain crank — no server watches the price, the rollup does.
#[account]
pub struct GuardConfig {
    pub vault: Pubkey,  // owning vault PDA (also the Flash position owner)
    pub owner: Pubkey,  // trader (for events / convenience)
    pub market: Pubkey, // Flash pool key, identifies the market + the price feed
    pub side: u8,       // Flash position side byte (0 = Long, 1 = Short)
    pub rule: RuleType,
    pub trigger_price: u64,     // oracle-units price that trips the rule (ratchets for trailing)
    pub trail_distance: u64,    // for TrailingStop: how far below the high the stop trails
    pub close_price_limit: u64, // slippage-protected price passed to Flash (ClosePositionParams.price)
    pub last_price: u64,        // most recent price seen by the crank (telemetry / demo)
    pub high_water: u64,        // highest price seen (telemetry for trailing)
    pub triggered: bool,        // set by the ER crank when the rule trips
    pub executed: bool,         // set by execute_protection after the Flash close
    pub active: bool,           // false once executed or cancelled
    pub bump: u8,
}

impl GuardConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1;

    /// For a trailing stop, ratchet the trigger up as the price rises (never down).
    /// Runs every crank tick — this is what makes the trailing stop fully on-chain.
    pub fn ratchet(&mut self, price: u64) {
        if price > self.high_water {
            self.high_water = price;
        }
        if matches!(self.rule, RuleType::TrailingStop) && self.trail_distance > 0 {
            let candidate = price.saturating_sub(self.trail_distance);
            if candidate > self.trigger_price {
                self.trigger_price = candidate;
            }
        }
    }

    /// Evaluate the rule against an observed price.
    pub fn is_tripped(&self, price: u64) -> bool {
        match self.rule {
            RuleType::PriceBelow | RuleType::TrailingStop => price <= self.trigger_price,
            RuleType::PriceAbove => price >= self.trigger_price,
        }
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
    pub bump: u8,
}

impl PriceFeed {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 1;
}
