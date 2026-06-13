use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::state::GuardConfig;

/// Commit the (now triggered) guard back to the base layer and undelegate it.
/// Permissionless: anyone can poke this once the rollup has flipped `triggered`,
/// because the only thing it does is push trustless rollup state down to L1.
/// `magic_program` and `magic_context` are injected by the `#[commit]` macro.
#[commit]
#[derive(Accounts)]
pub struct CommitGuard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub guard: Account<'info, GuardConfig>,
}

pub fn handler(ctx: Context<CommitGuard>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.guard.to_account_info()])
    .build_and_invoke()?;

    msg!("Guard committed + undelegated to base layer for settlement");
    Ok(())
}
