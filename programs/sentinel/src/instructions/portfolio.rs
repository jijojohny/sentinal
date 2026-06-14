use anchor_lang::prelude::*;

use crate::constants::PORTFOLIO_SEED;
use crate::state::{GuardConfig, PortfolioGuard, TRIP_STOP};

#[derive(Accounts)]
pub struct InitPortfolio<'info> {
    #[account(
        init, payer = owner, space = PortfolioGuard::LEN,
        seeds = [PORTFOLIO_SEED, owner.key().as_ref()], bump
    )]
    pub portfolio: Account<'info, PortfolioGuard>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_portfolio(ctx: Context<InitPortfolio>, max_drawdown_bps: u16) -> Result<()> {
    let p = &mut ctx.accounts.portfolio;
    p.owner = ctx.accounts.owner.key();
    p.max_drawdown_bps = max_drawdown_bps;
    p.peak_equity = 0;
    p.last_equity = 0;
    p.breached = false;
    p.bump = ctx.bumps.portfolio;
    msg!("Portfolio guard set: max drawdown {} bps", max_drawdown_bps);
    Ok(())
}

/// Permissionless: sum equity across the owner's guards (passed as remaining_accounts),
/// update the high-water mark, and if drawdown exceeds the threshold, trip every guard
/// (normal settlement then closes them). Equity proxy = Σ last_price of active guards.
#[derive(Accounts)]
pub struct EnforceDrawdown<'info> {
    #[account(mut, seeds = [PORTFOLIO_SEED, portfolio.owner.as_ref()], bump = portfolio.bump)]
    pub portfolio: Account<'info, PortfolioGuard>,
    pub cranker: Signer<'info>,
}

pub fn enforce_drawdown<'info>(ctx: Context<'info, EnforceDrawdown<'info>>) -> Result<()> {
    let owner = ctx.accounts.portfolio.owner;
    let mut equity: u128 = 0;
    for acc in ctx.remaining_accounts.iter() {
        if acc.owner != &crate::ID { continue; }
        let g = GuardConfig::try_deserialize(&mut &acc.try_borrow_data()?[..])?;
        if g.owner == owner && g.active && !g.executed {
            equity += g.last_price as u128;
        }
    }
    let p = &mut ctx.accounts.portfolio;
    let eq = equity as u64;
    p.last_equity = eq;
    if eq > p.peak_equity { p.peak_equity = eq; }

    // breached if equity fell below peak * (1 - dd).
    let floor = (p.peak_equity as u128 * (10_000 - p.max_drawdown_bps as u128) / 10_000) as u64;
    if p.peak_equity > 0 && eq < floor {
        p.breached = true;
        msg!("DRAWDOWN BREACHED: equity {} < floor {} — tripping all guards", eq, floor);
        for acc in ctx.remaining_accounts.iter() {
            if acc.owner != &crate::ID { continue; }
            let mut g = GuardConfig::try_deserialize(&mut &acc.try_borrow_data()?[..])?;
            if g.owner == owner && g.active && !g.triggered {
                g.triggered = true;
                g.trip_reason = TRIP_STOP;
                let mut buf = acc.try_borrow_mut_data()?;
                g.try_serialize(&mut &mut buf[..])?;
            }
        }
    }
    Ok(())
}
