use anchor_lang::prelude::*;

use crate::constants::{GUARD_SEED, PRICE_SEED, STRATEGY_SEED, VAULT_SEED};
use crate::state::{GuardConfig, PriceFeed, Strategy, TRIP_NONE};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FollowStrategyParams {
    pub guard_id: u64,
    pub market: Pubkey,
    pub initial_price: u64,
    pub close_price_limit: u64,
}

/// A follower instantiates their own guard from a published strategy. The
/// strategy's offsets are applied to the follower's own entry price, so each
/// follower gets a guard sized to their position — non-custodial copy trading.
#[derive(Accounts)]
#[instruction(params: FollowStrategyParams)]
pub struct FollowStrategy<'info> {
    #[account(
        mut,
        seeds = [STRATEGY_SEED, strategy.leader.as_ref(), &strategy.strategy_id.to_le_bytes()],
        bump = strategy.bump,
    )]
    pub strategy: Account<'info, Strategy>,

    /// CHECK: follower's data-less vault PDA.
    #[account(seeds = [VAULT_SEED, follower.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(
        init,
        payer = follower,
        space = GuardConfig::LEN,
        seeds = [GUARD_SEED, vault.key().as_ref(), &params.guard_id.to_le_bytes()],
        bump
    )]
    pub guard: Account<'info, GuardConfig>,

    #[account(
        init,
        payer = follower,
        space = PriceFeed::LEN,
        seeds = [PRICE_SEED, vault.key().as_ref(), &params.guard_id.to_le_bytes()],
        bump
    )]
    pub price_feed: Account<'info, PriceFeed>,

    #[account(mut)]
    pub follower: Signer<'info>,

    /// CHECK: strategy leader — receives the follow fee.
    #[account(mut, address = strategy.leader @ crate::error::SentinelError::VaultMismatch)]
    pub leader: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FollowStrategy>, params: FollowStrategyParams) -> Result<()> {
    let s = &ctx.accounts.strategy;
    let entry = params.initial_price;

    let guard = &mut ctx.accounts.guard;
    guard.vault = ctx.accounts.vault.key();
    guard.owner = ctx.accounts.follower.key();
    guard.market = params.market;
    guard.guard_id = params.guard_id;
    guard.side = s.side;
    guard.rule = s.rule;
    guard.action = s.action;
    guard.entry_price = entry;
    guard.trigger_price = entry.saturating_sub(s.stop_offset);
    guard.trail_distance = s.trail_distance;
    guard.tp_price = if s.tp_offset > 0 { entry.saturating_add(s.tp_offset) } else { 0 };
    guard.breakeven_offset = s.breakeven_offset;
    guard.expiry_ts = 0;
    guard.margin_amount = s.margin_amount;
    guard.close_price_limit = params.close_price_limit;
    guard.last_price = entry;
    guard.high_water = entry;
    guard.triggered = false;
    guard.executed = false;
    guard.active = true;
    guard.breakeven_armed = false;
    guard.trip_reason = TRIP_NONE;
    guard.bump = ctx.bumps.guard;

    let feed = &mut ctx.accounts.price_feed;
    feed.market = params.market;
    feed.price = entry;
    feed.ts = Clock::get()?.unix_timestamp;
    feed.bump = ctx.bumps.price_feed;

    // Pay the leader's follow fee (follower signs; plain transfer).
    let fee = ctx.accounts.strategy.fee_lamports;
    if fee > 0 {
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.follower.key(),
                &ctx.accounts.leader.key(),
                fee,
            ),
            &[
                ctx.accounts.follower.to_account_info(),
                ctx.accounts.leader.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    let strat = &mut ctx.accounts.strategy;
    strat.followers = strat.followers.saturating_add(1);

    msg!(
        "Followed strategy #{}: guard trigger={} tp={} (entry {})",
        strat.strategy_id,
        guard.trigger_price,
        guard.tp_price,
        entry
    );
    Ok(())
}
