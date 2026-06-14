use anchor_lang::prelude::*;

use crate::state::PriceFeed;

/// Push a fresh price into the feed. Runs inside the rollup (gasless). In
/// production this is the Pyth Lazer adapter; in the demo it is the price-pusher
/// that drives the crash. It only writes a number — it has no power to close
/// positions, so it is not a trusted keeper.
#[derive(Accounts)]
pub struct PushPrice<'info> {
    #[account(mut)]
    pub price_feed: Account<'info, PriceFeed>,
}

pub fn handler(ctx: Context<PushPrice>, price: u64, ts: i64) -> Result<()> {
    let feed = &mut ctx.accounts.price_feed;
    feed.price = price;
    feed.ts = ts;
    feed.record(price);
    Ok(())
}
