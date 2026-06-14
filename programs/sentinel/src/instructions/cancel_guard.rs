use anchor_lang::prelude::*;

use crate::constants::{GUARD_SEED, PRICE_SEED, VAULT_SEED};
use crate::error::SentinelError;
use crate::state::{GuardConfig, PriceFeed};

/// Trader cancels a guard and reclaims the guard + price-feed rent. Non-custodial:
/// only the vault owner can call it, and it returns rent to the trader. Use when
/// the guard is on the base layer (not currently delegated to the rollup).
#[derive(Accounts)]
#[instruction(guard_id: u64)]
pub struct CancelGuard<'info> {
    /// CHECK: data-less vault PDA (seed authority).
    #[account(seeds = [VAULT_SEED, trader.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        close = trader,
        seeds = [GUARD_SEED, vault.key().as_ref(), &guard_id.to_le_bytes()],
        bump = guard.bump,
        constraint = guard.owner == trader.key() @ SentinelError::VaultMismatch,
    )]
    pub guard: Account<'info, GuardConfig>,

    #[account(
        mut,
        close = trader,
        seeds = [PRICE_SEED, vault.key().as_ref(), &guard_id.to_le_bytes()],
        bump = price_feed.bump,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    #[account(mut)]
    pub trader: Signer<'info>,
}

pub fn handler(_ctx: Context<CancelGuard>, _guard_id: u64) -> Result<()> {
    msg!("Guard cancelled; guard + price feed closed, rent returned to trader");
    Ok(())
}
