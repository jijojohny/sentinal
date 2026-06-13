use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use sha2::{Digest, Sha256};

use crate::constants::VAULT_SEED;
use crate::error::SentinelError;

/// Mirrors Flash `OpenPositionParams { price, collateral, size, side }`.
/// `side` is the Flash `Side` byte: 1 = Long, 2 = Short (0 = None).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct OpenProtectedParams {
    pub price: u64,
    pub collateral: u64,
    pub size: u64,
    pub side: u8,
}

/// Open a Flash position *owned by the vault PDA*. This is the precondition for
/// the whole guardian: because the vault is the position owner, Sentinel can
/// later sign the protective close itself (execute_protection) without the
/// trader's key. The trader authorizes the open and funds the vault's collateral
/// ATA beforehand; the vault PDA signs the Flash CPI via invoke_signed.
///
/// `remaining_accounts` are Flash `open_position` accounts in its `OpenPosition`
/// order, minus `owner` (the vault PDA, supplied as the signer):
///   0 funding_account (mut)        1 transfer_authority
///   2 perpetuals                   3 pool (mut)
///   4 position (mut, init)         5 custody (mut)
///   6 custody_oracle               7 collateral_custody (mut)
///   8 collateral_custody_oracle    9 collateral_custody_token_account (mut)
///  10 system_program              11 token_program
#[derive(Accounts)]
pub struct OpenProtectedPosition<'info> {
    /// CHECK: data-less vault PDA — the Flash position `owner`, pays the position
    /// rent, and signs the CPI via invoke_signed. mut: lamports change on open.
    #[account(mut, seeds = [VAULT_SEED, trader.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: authorizing trader (== the vault seed authority). Present for parity
    /// with the Flash account layout; the seed binds the vault to this trader.
    pub owner: UncheckedAccount<'info>,

    /// CHECK: target venue program to CPI. In production pin this to
    /// constants::FLASH_PROGRAM_ID; for the devnet harness we accept the passed
    /// program so we can point at the interface-faithful flash_stub.
    pub flash_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub trader: Signer<'info>,
}

pub fn handler<'info>(
    ctx: Context<'info, OpenProtectedPosition<'info>>,
    params: OpenProtectedParams,
) -> Result<()> {
    let flash_accounts = ctx.remaining_accounts;
    require!(flash_accounts.len() >= 12, SentinelError::NotEnoughAccounts);

    // discriminator = sha256("global:open_position")[..8]
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&Sha256::digest(b"global:open_position")[..8]);

    let mut data = Vec::with_capacity(8 + 25);
    data.extend_from_slice(&disc);
    params.serialize(&mut data)?;

    // owner (vault PDA) is the signer; rest mirror OpenPosition's account order.
    let writable = [
        true, false, false, true, true, true, false, true, false, true, false, false,
    ];
    let mut metas = Vec::with_capacity(13);
    metas.push(AccountMeta::new(ctx.accounts.vault.key(), true)); // owner, signer, mut
    for (i, acc) in flash_accounts.iter().take(12).enumerate() {
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

    let mut infos = Vec::with_capacity(13);
    infos.push(ctx.accounts.vault.to_account_info());
    for acc in flash_accounts.iter().take(12) {
        infos.push(acc.clone());
    }

    let owner_key = ctx.accounts.trader.key();
    let bump = ctx.bumps.vault;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &[bump]]];

    invoke_signed(&ix, &infos, signer_seeds)?;

    msg!("Vault-owned Flash position opened (side={})", params.side);
    Ok(())
}
