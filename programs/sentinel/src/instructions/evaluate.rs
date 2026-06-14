use anchor_lang::prelude::*;

use crate::error::SentinelError;
use crate::state::{GuardConfig, PriceFeed, RuleType};

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
    let ts = ctx.accounts.price_feed.ts;

    // Nothing to do once the guard is spent.
    if !guard.active || guard.triggered {
        return Ok(());
    }

    if price == 0 {
        return Ok(());
    }
    guard.last_price = price;

    // Volatility-scaled trailing: size the trail to realized vol each tick (on-chain compute).
    if guard.vol_k > 0 && matches!(guard.rule, RuleType::TrailingStop) {
        let vol = ctx.accounts.price_feed.volatility();
        let dyn_trail = (vol as u128 * guard.vol_k as u128 / 10_000) as u64;
        if dyn_trail > 0 {
            guard.trail_distance = dyn_trail;
        }
    }

    // Per-tick maintenance: trailing-stop ratchet + breakeven arming — on-chain, no server.
    guard.ratchet(price);

    let mut reason = guard.trip_reason(price, ts);
    // Scale-out ladder: trip the next take-profit rung when price reaches it.
    if reason == crate::state::TRIP_NONE {
        let rungs = guard.ladder_rungs();
        if rungs > 0 && guard.ladder_done < rungs {
            let rung = guard.tp_ladder[guard.ladder_done as usize];
            if rung > 0 && price >= rung {
                reason = crate::state::TRIP_TP;
            }
        }
    }
    if reason != crate::state::TRIP_NONE {
        guard.triggered = true;
        guard.trip_reason = reason;
        // Anti-MEV: lock settlement for settle_delay + a pseudo-random jitter so the exact
        // settle moment isn't predictable/front-runnable. (Jitter seed = on-chain price/time;
        // upgradeable to MagicBlock VRF for cryptographic unpredictability.)
        if guard.settle_delay > 0 {
            let seed = price
                ^ (ts as u64).wrapping_mul(2654435761)
                ^ guard.guard_id.wrapping_mul(40503);
            let jitter = (seed % (guard.settle_delay as u64).max(1)) as i64;
            guard.settle_after_ts = ts + guard.settle_delay + jitter;
        }
        msg!(
            "GUARD TRIPPED in rollup: reason={} price={} trigger={} tp={} rule={:?}",
            reason,
            price,
            guard.trigger_price,
            guard.tp_price,
            guard.rule
        );
    }
    Ok(())
}
