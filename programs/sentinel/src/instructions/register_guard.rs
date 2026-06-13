use anchor_lang::prelude::*;

use crate::constants::{GUARD_SEED, PRICE_SEED, VAULT_SEED};
use crate::state::{GuardConfig, PriceFeed, RuleType};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterGuardParams {
    pub market: Pubkey,
    pub side: u8,
    pub rule: RuleType,
    pub trigger_price: u64,
    pub trail_distance: u64, // 0 for fixed rules; >0 for TrailingStop
    pub close_price_limit: u64,
    pub initial_price: u64,
}

/// Register a protection rule for a Flash position the vault owns, and create
/// the price-feed account the crank will read in the rollup.
#[derive(Accounts)]
pub struct RegisterGuard<'info> {
    /// CHECK: data-less vault PDA (the Flash position owner / signer).
    #[account(seeds = [VAULT_SEED, trader.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(
        init,
        payer = trader,
        space = GuardConfig::LEN,
        seeds = [GUARD_SEED, vault.key().as_ref()],
        bump
    )]
    pub guard: Account<'info, GuardConfig>,

    #[account(
        init,
        payer = trader,
        space = PriceFeed::LEN,
        seeds = [PRICE_SEED, vault.key().as_ref()],
        bump
    )]
    pub price_feed: Account<'info, PriceFeed>,

    #[account(mut)]
    pub trader: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterGuard>, params: RegisterGuardParams) -> Result<()> {
    let guard = &mut ctx.accounts.guard;
    guard.vault = ctx.accounts.vault.key();
    guard.owner = ctx.accounts.trader.key();
    guard.market = params.market;
    guard.side = params.side;
    guard.rule = params.rule;
    guard.trigger_price = params.trigger_price;
    guard.trail_distance = params.trail_distance;
    guard.close_price_limit = params.close_price_limit;
    guard.last_price = params.initial_price;
    guard.high_water = params.initial_price;
    guard.triggered = false;
    guard.executed = false;
    guard.active = true;
    guard.bump = ctx.bumps.guard;

    let feed = &mut ctx.accounts.price_feed;
    feed.market = params.market;
    feed.price = params.initial_price;
    feed.ts = Clock::get()?.unix_timestamp;
    feed.bump = ctx.bumps.price_feed;

    msg!(
        "Guard registered: rule={:?} trigger={} market={}",
        guard.rule,
        guard.trigger_price,
        guard.market
    );
    Ok(())
}
