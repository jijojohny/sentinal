use anchor_lang::prelude::*;

#[error_code]
pub enum SentinelError {
    #[msg("Guard is not active")]
    GuardInactive,
    #[msg("Guard rule has not been triggered yet")]
    NotTriggered,
    #[msg("Guard has already been executed")]
    AlreadyExecuted,
    #[msg("Price feed is stale or zero")]
    BadPrice,
    #[msg("Wrong vault authority for this guard")]
    VaultMismatch,
    #[msg("Provided Flash accounts do not match the guard's market")]
    MarketMismatch,
    #[msg("Not enough accounts supplied for the Flash close CPI")]
    NotEnoughAccounts,
    #[msg("Wrong guard kind for this instruction")]
    WrongKind,
    #[msg("Settlement is time-locked (anti-MEV delay not elapsed)")]
    SettleLocked,
}
