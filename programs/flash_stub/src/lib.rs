use anchor_lang::prelude::*;

declare_id!("3pueX18BCYp8D2qNbdTrDeLDhP25uuEHe7HG2DCfqd8F");

/// flash_stub — a settlement HARNESS, not Flash itself.
///
/// It mirrors the `flash-trade/flash-perpetuals` `open_position` / `close_position`
/// interface *exactly* — same Anchor instruction names (so the 8-byte
/// discriminators match), same account ORDER, same params structs — so Sentinel's
/// hand-built CPIs (`open_protected_position`, `execute_protection`) work against
/// it byte-for-byte identically to the real reference program (verified deployed
/// on devnet at Bmr31xzZYYVUdoHmAJL1DAp2anaitW8Tw9YfASS94MKJ).
///
/// We use it only because bootstrapping a fresh pool on the live reference program
/// requires admin/IDL access we don't have. The CPI wiring it exercises is the real
/// thing; the perp accounting is reduced to a position-lifecycle record so the demo
/// can show "guard auto-closes the position" end-to-end on devnet.
#[program]
pub mod flash_stub {
    use super::*;

    /// Matches Flash `open_position(params: OpenPositionParams)`.
    pub fn open_position(ctx: Context<OpenPosition>, params: OpenPositionParams) -> Result<()> {
        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.owner.key();
        position.side = params.side;
        position.size = params.size;
        position.collateral = params.collateral;
        position.entry_price = params.price;
        position.open = true;
        position.bump = ctx.bumps.position;
        msg!(
            "[flash_stub] open_position: owner={} side={} size={} entry={}",
            position.owner,
            position.side,
            position.size,
            position.entry_price
        );
        Ok(())
    }

    /// Matches Flash `close_position(params: ClosePositionParams)`. Closes the
    /// position account (rent → owner), which is the on-chain proof the guard
    /// auto-closed the trade.
    pub fn close_position(ctx: Context<ClosePosition>, params: ClosePositionParams) -> Result<()> {
        msg!(
            "[flash_stub] close_position: owner={} exit_limit={} (position closed)",
            ctx.accounts.owner.key(),
            params.price
        );
        Ok(())
    }

    /// Matches Flash `add_collateral(params: AddCollateralParams)` — liquidation
    /// defense. Increases the position's collateral instead of closing it.
    pub fn add_collateral(ctx: Context<AddCollateral>, params: AddCollateralParams) -> Result<()> {
        let position = &mut ctx.accounts.position;
        position.collateral = position.collateral.saturating_add(params.collateral);
        msg!(
            "[flash_stub] add_collateral: owner={} +{} → collateral {}",
            ctx.accounts.owner.key(),
            params.collateral,
            position.collateral
        );
        Ok(())
    }

    /// Partial close (scale-out): reduce the position size; close it once it hits 0.
    pub fn decrease_position(ctx: Context<AddCollateral>, params: DecreaseParams) -> Result<()> {
        let position = &mut ctx.accounts.position;
        position.size = position.size.saturating_sub(params.size);
        if position.size == 0 {
            position.open = false;
        }
        msg!("[flash_stub] decrease_position: -{} → size {}", params.size, position.size);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct OpenPositionParams {
    pub price: u64,
    pub collateral: u64,
    pub size: u64,
    pub side: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ClosePositionParams {
    pub price: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct AddCollateralParams {
    pub collateral: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct DecreaseParams {
    pub size: u64,
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub side: u8,
    pub size: u64,
    pub collateral: u64,
    pub entry_price: u64,
    pub open: bool,
    pub bump: u8,
}

impl Position {
    pub const LEN: usize = 8 + 32 + 1 + 8 + 8 + 8 + 1 + 1;
}

/// Account order mirrors Flash `OpenPosition` exactly (owner + 12). Unused
/// accounts are accepted (CHECK) so the positional layout matches the real CPI.
#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: funding (collateral) account — unused in the harness.
    #[account(mut)]
    pub funding_account: UncheckedAccount<'info>,
    /// CHECK: transfer authority PDA.
    pub transfer_authority: UncheckedAccount<'info>,
    /// CHECK: perpetuals config.
    pub perpetuals: UncheckedAccount<'info>,
    /// CHECK: pool.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = Position::LEN,
        seeds = [b"position", owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    /// CHECK: custody.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: custody oracle.
    pub custody_oracle: UncheckedAccount<'info>,
    /// CHECK: collateral custody.
    #[account(mut)]
    pub collateral_custody: UncheckedAccount<'info>,
    /// CHECK: collateral custody oracle.
    pub collateral_custody_oracle: UncheckedAccount<'info>,
    /// CHECK: collateral custody token account.
    #[account(mut)]
    pub collateral_custody_token_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: token program (unused in harness).
    pub token_program: UncheckedAccount<'info>,
}

/// Account order mirrors Flash `AddCollateral` exactly (owner + 11): funding,
/// transferAuth, perpetuals, pool, position, custody, custodyOracle, collCustody,
/// collOracle, collTokenAcct, token. Position stays open (collateral increases).
#[derive(Accounts)]
pub struct AddCollateral<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: funding account — unused in the harness.
    #[account(mut)]
    pub funding_account: UncheckedAccount<'info>,
    /// CHECK: transfer authority.
    pub transfer_authority: UncheckedAccount<'info>,
    /// CHECK: perpetuals.
    pub perpetuals: UncheckedAccount<'info>,
    /// CHECK: pool.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"position", owner.key().as_ref()], bump = position.bump, has_one = owner)]
    pub position: Account<'info, Position>,
    /// CHECK: custody.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: custody oracle.
    pub custody_oracle: UncheckedAccount<'info>,
    /// CHECK: collateral custody.
    #[account(mut)]
    pub collateral_custody: UncheckedAccount<'info>,
    /// CHECK: collateral custody oracle.
    pub collateral_custody_oracle: UncheckedAccount<'info>,
    /// CHECK: collateral custody token account.
    #[account(mut)]
    pub collateral_custody_token_account: UncheckedAccount<'info>,
    /// CHECK: token program (unused).
    pub token_program: UncheckedAccount<'info>,
}

/// Account order mirrors Flash `ClosePosition` exactly (owner + 11).
#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: receiving account — unused in the harness.
    #[account(mut)]
    pub receiving_account: UncheckedAccount<'info>,
    /// CHECK: transfer authority PDA.
    pub transfer_authority: UncheckedAccount<'info>,
    /// CHECK: perpetuals config.
    pub perpetuals: UncheckedAccount<'info>,
    /// CHECK: pool.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"position", owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        close = owner
    )]
    pub position: Account<'info, Position>,
    /// CHECK: custody.
    #[account(mut)]
    pub custody: UncheckedAccount<'info>,
    /// CHECK: custody oracle.
    pub custody_oracle: UncheckedAccount<'info>,
    /// CHECK: collateral custody.
    #[account(mut)]
    pub collateral_custody: UncheckedAccount<'info>,
    /// CHECK: collateral custody oracle.
    pub collateral_custody_oracle: UncheckedAccount<'info>,
    /// CHECK: collateral custody token account.
    #[account(mut)]
    pub collateral_custody_token_account: UncheckedAccount<'info>,
    /// CHECK: token program (unused in harness).
    pub token_program: UncheckedAccount<'info>,
}
