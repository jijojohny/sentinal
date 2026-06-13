use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};

use crate::constants::VAULT_SEED;

/// Trader withdraws all lamports from their data-less vault PDA back to their
/// wallet — the non-custodial exit. The vault signs the System transfer via
/// invoke_signed; only the seed-bound trader can drain it.
#[derive(Accounts)]
pub struct WithdrawVault<'info> {
    /// CHECK: data-less vault PDA, System-owned; drained via invoke_signed.
    #[account(mut, seeds = [VAULT_SEED, trader.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub trader: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<WithdrawVault>) -> Result<()> {
    let lamports = ctx.accounts.vault.lamports();
    if lamports == 0 {
        return Ok(());
    }
    let owner = ctx.accounts.trader.key();
    let bump = ctx.bumps.vault;
    let ix = system_instruction::transfer(&ctx.accounts.vault.key(), &owner, lamports);
    invoke_signed(
        &ix,
        &[
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.trader.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[VAULT_SEED, owner.as_ref(), &[bump]]],
    )?;
    msg!("Withdrew {} lamports from vault to trader", lamports);
    Ok(())
}
