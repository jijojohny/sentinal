use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;
use crate::state::Vault;

/// Create the trader's vault. The vault PDA becomes the owner of the Flash
/// position, so Sentinel can later sign the protective close itself.
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = trader,
        space = Vault::LEN,
        seeds = [VAULT_SEED, trader.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub trader: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.trader.key();
    vault.guards = 0;
    vault.bump = ctx.bumps.vault;
    msg!("Vault initialized for {}", vault.owner);
    Ok(())
}
