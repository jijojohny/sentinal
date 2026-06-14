use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use sha2::{Digest, Sha256};

use crate::constants::VAULT_SEED;
use crate::error::SentinelError;
use crate::state::{ActionType, GuardConfig};

/// Slippage-protected price arg expected by Flash `close_position`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ClosePositionParams {
    pub price: u64,
}

/// Collateral arg expected by Flash `add_collateral` (liquidation defense).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct AddCollateralParams {
    pub collateral: u64,
}

/// Size arg for the venue partial close (scale-out ladders).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct DecreaseParams {
    pub size: u64,
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

    /// Anyone can pay/submit; carries no authority. Earns `keeper_bounty`.
    #[account(mut)]
    pub cranker: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'info, ExecuteProtection<'info>>) -> Result<()> {
    let guard = &mut ctx.accounts.guard;
    require!(guard.active, SentinelError::GuardInactive);
    require!(guard.triggered, SentinelError::NotTriggered);
    require!(!guard.executed, SentinelError::AlreadyExecuted);
    if guard.settle_after_ts > 0 {
        require!(Clock::get()?.unix_timestamp >= guard.settle_after_ts, SentinelError::SettleLocked);
    }

    let flash_accounts = ctx.remaining_accounts;
    require!(flash_accounts.len() >= 11, SentinelError::NotEnoughAccounts);

    // Branch on guard mode — all three Flash instructions share the same owner + 11-account
    // layout + writable mask; only the discriminator + params differ.
    //   ladder      → decrease_position (partial scale-out, re-arms for the next rung)
    //   add_margin  → add_collateral    (liquidation defense)
    //   else        → close_position
    let rungs = guard.ladder_rungs();
    let ladder = rungs > 0;
    let add_margin = !ladder && matches!(guard.action, ActionType::AddMargin);
    let disc_seed: &[u8] = if ladder { b"global:decrease_position" } else if add_margin { b"global:add_collateral" } else { b"global:close_position" };
    let mut data = Vec::with_capacity(16);
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&Sha256::digest(disc_seed)[..8]);
    data.extend_from_slice(&disc);
    if ladder {
        let chunk = guard.entry_size / (rungs as u64).max(1);
        DecreaseParams { size: chunk }.serialize(&mut data)?;
    } else if add_margin {
        AddCollateralParams { collateral: guard.margin_amount }.serialize(&mut data)?;
    } else {
        ClosePositionParams { price: guard.close_price_limit }.serialize(&mut data)?;
    }

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

    if ladder {
        // Scale-out: this rung is done; re-arm for the next, or finish on the last.
        guard.ladder_done += 1;
        if guard.ladder_done < rungs {
            guard.triggered = false;
            guard.trip_reason = crate::state::TRIP_NONE;
            guard.settle_after_ts = 0; // re-arm: next rung recomputes its own anti-MEV lock
            msg!("Ladder rung {} of {} closed; re-armed for next", guard.ladder_done, rungs);
        } else {
            guard.executed = true;
            guard.active = false;
        }
    } else {
        guard.executed = true;
        guard.active = false;
    }

    // Incentivized keeper: pay the cranker a bounty from the vault (permissionless + reliably live).
    let bounty = guard.keeper_bounty;
    if bounty > 0 && ctx.accounts.vault.lamports() > bounty {
        let pay = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.vault.key(),
            &ctx.accounts.cranker.key(),
            bounty,
        );
        invoke_signed(
            &pay,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.cranker.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;
        msg!("Keeper bounty paid: {} lamports → {}", bounty, ctx.accounts.cranker.key());
    }
    if add_margin {
        msg!("Protection executed: margin added to defend the position (one-shot)");
    } else {
        msg!("Protection executed: Flash position closed by Sentinel vault");
    }
    Ok(())
}
