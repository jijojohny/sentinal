use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use sha2::{Digest, Sha256};

use crate::constants::VAULT_SEED;
use crate::error::SentinelError;
use crate::state::GuardConfig;

/// Slippage-protected price arg expected by Flash `close_position`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ClosePositionParams {
    pub price: u64,
}

/// The settlement leg, on the base layer. Permissionless: anyone may submit it,
/// but it only does something if the committed guard says `triggered`. It then
/// CPIs Flash `close_position`, signing as the vault PDA (the position owner).
/// The submitter has zero discretion — the program is the keeper.
///
/// `remaining_accounts` are the Flash `close_position` accounts in the exact
/// order of its `ClosePosition` context, minus `owner` (which is the vault PDA
/// and is supplied here as the signer):
///   0 receiving_account (mut)      1 transfer_authority
///   2 perpetuals                   3 pool (mut)
///   4 position (mut)               5 custody (mut)
///   6 custody_oracle               7 collateral_custody (mut)
///   8 collateral_custody_oracle    9 collateral_custody_token_account (mut)
///  10 token_program
#[derive(Accounts)]
pub struct ExecuteProtection<'info> {
    #[account(mut)]
    pub guard: Account<'info, GuardConfig>,

    /// CHECK: data-less vault PDA — the Flash position owner/signer; receives the
    /// closed rent/proceeds. mut: lamports change on close. Bound to guard.owner
    /// via seeds, and cross-checked against guard.vault below.
    #[account(
        mut,
        seeds = [VAULT_SEED, guard.owner.as_ref()],
        bump,
        constraint = guard.vault == vault.key() @ SentinelError::VaultMismatch,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: target venue program to CPI. In production pin this to
    /// constants::FLASH_PROGRAM_ID; for the devnet harness we accept the passed
    /// program so we can point at the interface-faithful flash_stub.
    pub flash_program: UncheckedAccount<'info>,

    /// Anyone can pay/submit; carries no authority.
    #[account(mut)]
    pub cranker: Signer<'info>,
}

pub fn handler<'info>(ctx: Context<'info, ExecuteProtection<'info>>) -> Result<()> {
    let guard = &mut ctx.accounts.guard;
    require!(guard.active, SentinelError::GuardInactive);
    require!(guard.triggered, SentinelError::NotTriggered);
    require!(!guard.executed, SentinelError::AlreadyExecuted);

    let flash_accounts = ctx.remaining_accounts;
    require!(flash_accounts.len() >= 11, SentinelError::NotEnoughAccounts);

    // Anchor instruction discriminator: sha256("global:close_position")[..8].
    let mut disc = [0u8; 8];
    let hash = Sha256::digest(b"global:close_position");
    disc.copy_from_slice(&hash[..8]);

    let mut data = Vec::with_capacity(8 + 8);
    data.extend_from_slice(&disc);
    ClosePositionParams {
        price: guard.close_price_limit,
    }
    .serialize(&mut data)?;

    // owner (vault PDA) is the signer; the rest mirror ClosePosition's account order.
    let mut metas = Vec::with_capacity(12);
    metas.push(AccountMeta::new(ctx.accounts.vault.key(), true)); // owner, signer, mut
    let writable = [true, false, false, true, true, true, false, true, false, true, false];
    for (i, acc) in flash_accounts.iter().take(11).enumerate() {
        if writable[i] {
            metas.push(AccountMeta::new(acc.key(), false));
        } else {
            metas.push(AccountMeta::new_readonly(acc.key(), false));
        }
    }

    let ix = Instruction {
        program_id: ctx.accounts.flash_program.key(),
        accounts: metas,
        data,
    };

    // Assemble account infos for the CPI: vault (owner) + the 11 Flash accounts.
    let mut infos = Vec::with_capacity(12);
    infos.push(ctx.accounts.vault.to_account_info());
    for acc in flash_accounts.iter().take(11) {
        infos.push(acc.clone());
    }

    let owner_key = guard.owner;
    let bump = ctx.bumps.vault;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &[bump]]];

    invoke_signed(&ix, &infos, signer_seeds)?;

    guard.executed = true;
    guard.active = false;
    msg!("Protection executed: Flash position closed by Sentinel vault");
    Ok(())
}
