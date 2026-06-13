use anchor_lang::prelude::*;

use crate::error::SentinelError;
use crate::state::{GuardConfig, PriceFeed};

/// The crank handler. The MagicBlock scheduler invokes this every tick inside
/// the Ephemeral Rollup — no client transaction, no off-chain bot. It reads the
/// delegated price feed, records the latest price, and flips `triggered` the
/// instant the rule trips. This is the part that would otherwise require a 24/7
/// keeper server; here the chain itself does it.
#[derive(Accounts)]
pub struct Evaluate<'info> {
    #[account(mut)]
    pub guard: Account<'info, GuardConfig>,

    #[account(
        constraint = price_feed.market == guard.market @ SentinelError::MarketMismatch,
    )]
    pub price_feed: Account<'info, PriceFeed>,
}

pub fn handler(ctx: Context<Evaluate>) -> Result<()> {
    let guard = &mut ctx.accounts.guard;
    let price = ctx.accounts.price_feed.price;

    // Nothing to do once the guard is spent.
    if !guard.active || guard.triggered {
        return Ok(());
    }

    guard.last_price = price;

    if price > 0 && guard.is_tripped(price) {
        guard.triggered = true;
        msg!(
            "GUARD TRIPPED in rollup: price={} crossed trigger={} rule={:?}",
            price,
            guard.trigger_price,
            guard.rule
        );
    }
    Ok(())
}
