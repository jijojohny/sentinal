use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::{GUARD_SEED, PRICE_SEED, VAULT_SEED};

/// Delegate the guard + price-feed accounts (for one `guard_id`) to the Ephemeral
/// Rollup. After this, the crank can tick them at sub-10ms with no fees and no
/// server, and the base-layer copies stay frozen until we commit back.
#[delegate]
#[derive(Accounts)]
#[instruction(guard_id: u64)]
pub struct DelegateGuard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: vault PDA, used only to derive the guard/price seeds.
    #[account(seeds = [VAULT_SEED, payer.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: guard PDA to delegate.
    #[account(mut, del, seeds = [GUARD_SEED, vault.key().as_ref(), &guard_id.to_le_bytes()], bump)]
    pub guard: UncheckedAccount<'info>,

    /// CHECK: price-feed PDA to delegate.
    #[account(mut, del, seeds = [PRICE_SEED, vault.key().as_ref(), &guard_id.to_le_bytes()], bump)]
    pub price_feed: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<DelegateGuard>, guard_id: u64) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let gid = guard_id.to_le_bytes();

    ctx.accounts.delegate_guard(
        &ctx.accounts.payer,
        &[GUARD_SEED, vault_key.as_ref(), &gid],
        DelegateConfig::default(),
    )?;

    ctx.accounts.delegate_price_feed(
        &ctx.accounts.payer,
        &[PRICE_SEED, vault_key.as_ref(), &gid],
        DelegateConfig::default(),
    )?;

    msg!("Guard #{} + price feed delegated to the Ephemeral Rollup", guard_id);
    Ok(())
}
