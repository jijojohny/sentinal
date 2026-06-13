use anchor_lang::prelude::*;

/// Per-trader vault. Its PDA is the *owner* of the Flash position, which is what
/// lets Sentinel sign the protective close on the trader's behalf without ever
/// holding the trader's wallet key.
#[account]
pub struct Vault {
    pub owner: Pubkey, // the trader
    pub guards: u32,   // number of guards created (telemetry)
    pub bump: u8,      // PDA bump, used to invoke_signed Flash CPIs
}

impl Vault {
    pub const LEN: usize = 8 + 32 + 4 + 1;
}

/// The rule a guard enforces.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RuleType {
    /// Long stop-loss / short take-profit: fire when price <= trigger_price.
    PriceBelow,
    /// Long take-profit / short stop-loss: fire when price >= trigger_price.
    PriceAbove,
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
    pub trigger_price: u64,     // oracle-units price that trips the rule
    pub close_price_limit: u64, // slippage-protected price passed to Flash (ClosePositionParams.price)
    pub last_price: u64,        // most recent price seen by the crank (telemetry / demo)
    pub triggered: bool,        // set by the ER crank when the rule trips
    pub executed: bool,         // set by execute_protection after the Flash close
    pub active: bool,           // false once executed or cancelled
    pub bump: u8,
}

impl GuardConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 1 + 1 + 1 + 1;

    /// Evaluate the rule against an observed price.
    pub fn is_tripped(&self, price: u64) -> bool {
        match self.rule {
            RuleType::PriceBelow => price <= self.trigger_price,
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
