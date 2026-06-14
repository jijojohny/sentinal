use anchor_lang::prelude::*;

use crate::error::SentinelError;
use crate::state::PriceFeed;

/// Real-oracle adapter: read a Pyth `PriceUpdateV2` (pull oracle) account, decode
/// its price, normalize to the feed's 1e6 units, and write it into the Sentinel
/// price feed. This is the production price path (the "Pyth Lazer adapter") — the
/// crank then reads the feed inside the rollup exactly as in the demo. Permissionless:
/// the data is Pyth's, not the caller's; the caller only relays it.
///
/// Manual decode (no heavy SDK dep) of the documented PriceUpdateV2 layout:
///   disc(8) write_authority(32) verification_level(1 Full | 2 Partial)
///   price_message { feed_id(32) price(i64) conf(u64) exponent(i32) ... }
#[derive(Accounts)]
pub struct PushPriceFromPyth<'info> {
    #[account(mut)]
    pub price_feed: Account<'info, PriceFeed>,
    /// CHECK: a Pyth PriceUpdateV2 account; decoded read-only by layout.
    pub pyth_price_update: UncheckedAccount<'info>,
}

fn normalize_to_1e6(price: i64, expo: i32) -> u64 {
    if price <= 0 {
        return 0;
    }
    // feed (1e6 units) = price * 10^(expo + 6)
    let e = expo + 6;
    let p = price as i128;
    let v = if e >= 0 {
        p.saturating_mul(10i128.saturating_pow(e as u32))
    } else {
        p / 10i128.saturating_pow((-e) as u32)
    };
    if v < 0 {
        0
    } else if v > u64::MAX as i128 {
        u64::MAX
    } else {
        v as u64
    }
}

pub fn handler(ctx: Context<PushPriceFromPyth>) -> Result<()> {
    let data = ctx.accounts.pyth_price_update.try_borrow_data()?;
    require!(data.len() >= 96, SentinelError::BadPrice);

    // verification_level byte sits right after disc(8) + write_authority(32).
    let vl = data[40];
    // Full = variant 1 (1 byte); Partial = variant 0 + num_signatures u8 (2 bytes).
    let msg_off = 8 + 32 + if vl == 0 { 2 } else { 1 };
    let price_off = msg_off + 32; // after feed_id[32]
    let expo_off = price_off + 8 + 8; // after price(i64) + conf(u64)
    require!(data.len() >= expo_off + 4, SentinelError::BadPrice);

    let price = i64::from_le_bytes(data[price_off..price_off + 8].try_into().unwrap());
    let expo = i32::from_le_bytes(data[expo_off..expo_off + 4].try_into().unwrap());
    let norm = normalize_to_1e6(price, expo);
    require!(norm > 0, SentinelError::BadPrice);

    let feed = &mut ctx.accounts.price_feed;
    feed.price = norm;
    feed.ts = Clock::get()?.unix_timestamp;
    msg!("Pyth → feed: raw={} expo={} → {} (1e6)", price, expo, norm);
    Ok(())
}
