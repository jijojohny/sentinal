use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    system_instruction,
};
use sha2::{Digest, Sha256};

use crate::constants::VAULT_SEED;
use crate::error::SentinelError;
use crate::instructions::open_protected_position::OpenProtectedParams;
use crate::state::{GuardConfig, GuardKind, RuleType};

/// Permissionless fill of a limit-ENTRY guard. When the crank flips `triggered`
/// (price crossed the entry level), anyone can land this — it opens the vault-owned
/// position via the venue CPI (signed by the vault PDA) and pays the keeper bounty.
/// `remaining_accounts` are the venue `open_position` accounts (minus owner = vault),
/// same order as `open_protected_position`.
#[derive(Accounts)]
pub struct ExecuteEntry<'info> {
    #[account(mut)]
    pub guard: Account<'info, GuardConfig>,

    /// CHECK: data-less vault PDA — the position owner/signer + bounty source.
    #[account(
        mut,
        seeds = [VAULT_SEED, guard.owner.as_ref()],
        bump,
        constraint = guard.vault == vault.key() @ SentinelError::VaultMismatch,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: target venue program.
    pub flash_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub cranker: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'info, ExecuteEntry<'info>>) -> Result<()> {
    let guard = &mut ctx.accounts.guard;
    require!(guard.kind == GuardKind::Entry, SentinelError::WrongKind);
    require!(guard.active, SentinelError::GuardInactive);
    require!(guard.triggered, SentinelError::NotTriggered);
    require!(!guard.executed, SentinelError::AlreadyExecuted);
    if guard.settle_after_ts > 0 {
        require!(Clock::get()?.unix_timestamp >= guard.settle_after_ts, SentinelError::SettleLocked);
    }

    let flash_accounts = ctx.remaining_accounts;
    require!(flash_accounts.len() >= 12, SentinelError::NotEnoughAccounts);

    let mut disc = [0u8; 8];
    disc.copy_from_slice(&Sha256::digest(b"global:open_position")[..8]);
    let mut data = Vec::with_capacity(8 + 25);
    data.extend_from_slice(&disc);
    OpenProtectedParams {
        price: guard.trigger_price,
        collateral: guard.entry_collateral,
        size: guard.entry_size,
        side: guard.side,
    }
    .serialize(&mut data)?;

    let writable = [true, false, false, true, true, true, false, true, false, true, false, false];
    let mut metas = Vec::with_capacity(13);
    metas.push(AccountMeta::new(ctx.accounts.vault.key(), true)); // owner, signer, mut
    for (i, acc) in flash_accounts.iter().take(12).enumerate() {
        metas.push(if writable[i] { AccountMeta::new(acc.key(), false) } else { AccountMeta::new_readonly(acc.key(), false) });
    }
    let ix = Instruction { program_id: ctx.accounts.flash_program.key(), accounts: metas, data };

    let mut infos = Vec::with_capacity(13);
    infos.push(ctx.accounts.vault.to_account_info());
    for acc in flash_accounts.iter().take(12) {
        infos.push(acc.clone());
    }

    let owner_key = guard.owner;
    let bump = ctx.bumps.vault;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &[bump]]];
    invoke_signed(&ix, &infos, signer_seeds)?;

    if guard.bracket_stop > 0 {
        // Bracket: the entry filled — auto-arm protection on the now-open position.
        guard.kind = GuardKind::Protect;
        guard.rule = RuleType::PriceBelow;
        guard.entry_price = guard.trigger_price; // fill price = the entry trigger
        guard.trigger_price = guard.bracket_stop; // downside stop (tp_price stays as bracket TP)
        guard.triggered = false;
        guard.executed = false;
        guard.active = true;
        guard.trip_reason = crate::state::TRIP_NONE;
        guard.settle_after_ts = 0;
        msg!("Limit entry filled — bracket armed (stop {}, tp {})", guard.trigger_price, guard.tp_price);
    } else {
        guard.executed = true;
        guard.active = false;
        msg!("Limit entry filled by Sentinel vault (size {})", guard.entry_size);
    }

    let bounty = guard.keeper_bounty;
    if bounty > 0 && ctx.accounts.vault.lamports() > bounty {
        let pay = system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.cranker.key(), bounty);
        invoke_signed(
            &pay,
            &[ctx.accounts.vault.to_account_info(), ctx.accounts.cranker.to_account_info(), ctx.accounts.system_program.to_account_info()],
            signer_seeds,
        )?;
    }
    Ok(())
}
