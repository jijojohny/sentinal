use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};

use crate::constants::{GRID_SEED, PRICE_SEED, VAULT_SEED};
use crate::state::{GridConfig, PriceFeed};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitGridParams {
    pub grid_id: u64,
    pub market: Pubkey,
    pub lower: u64,
    pub upper: u64,
    pub levels: u8,
    pub order_size: u64,
    pub mode: u8,           // 0 = grid (level-cross), 1 = DCA (time-spaced)
    pub interval_ticks: u32,
    pub initial_price: u64,
}

#[derive(Accounts)]
#[instruction(params: InitGridParams)]
pub struct InitGrid<'info> {
    /// CHECK: data-less vault PDA.
    #[account(seeds = [VAULT_SEED, trader.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init, payer = trader, space = GridConfig::LEN,
        seeds = [GRID_SEED, vault.key().as_ref(), &params.grid_id.to_le_bytes()], bump
    )]
    pub grid: Account<'info, GridConfig>,
    #[account(
        init, payer = trader, space = PriceFeed::LEN,
        seeds = [PRICE_SEED, grid.key().as_ref()], bump
    )]
    pub grid_feed: Account<'info, PriceFeed>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_grid(ctx: Context<InitGrid>, params: InitGridParams) -> Result<()> {
    let g = &mut ctx.accounts.grid;
    g.vault = ctx.accounts.vault.key();
    g.owner = ctx.accounts.trader.key();
    g.market = params.market;
    g.grid_id = params.grid_id;
    g.lower = params.lower;
    g.upper = params.upper;
    g.levels = params.levels;
    g.order_size = params.order_size;
    g.mode = params.mode;
    g.interval_ticks = params.interval_ticks.max(1);
    g.tick_count = 0;
    g.last_level = -1;
    g.last_price = params.initial_price;
    g.fills = 0;
    g.active = true;
    g.bump = ctx.bumps.grid;

    let f = &mut ctx.accounts.grid_feed;
    f.market = params.market;
    f.price = params.initial_price;
    f.ts = Clock::get()?.unix_timestamp;
    f.bump = ctx.bumps.grid_feed;
    msg!("Grid #{} initialized: [{}, {}] x{} levels", g.grid_id, g.lower, g.upper, g.levels);
    Ok(())
}

/// The crank handler. Each tick it decides which rungs to act on — fully on-chain
/// in the rollup, no server. Grid mode fills on level crossings; DCA mode fills on
/// a fixed tick cadence. (Rung execution on Flash reuses the vault CPI path.)
#[derive(Accounts)]
pub struct GridStep<'info> {
    #[account(mut)]
    pub grid: Account<'info, GridConfig>,
    #[account(constraint = grid_feed.market == grid.market)]
    pub grid_feed: Account<'info, PriceFeed>,
}

pub fn grid_step(ctx: Context<GridStep>) -> Result<()> {
    let g = &mut ctx.accounts.grid;
    if !g.active {
        return Ok(());
    }
    let price = ctx.accounts.grid_feed.price;
    if price == 0 {
        return Ok(());
    }
    g.tick_count = g.tick_count.saturating_add(1);
    g.last_price = price;

    if g.mode == 1 {
        // DCA: act every interval_ticks.
        if g.tick_count % g.interval_ticks == 0 {
            g.fills = g.fills.saturating_add(1);
            msg!("DCA fill #{} @ {}", g.fills, price);
        }
    } else {
        // Grid: act when the price moves into a new band.
        let level = g.level_of(price);
        if g.last_level >= 0 && level != g.last_level {
            g.fills = g.fills.saturating_add(1);
            msg!("Grid fill #{}: level {} -> {} @ {}", g.fills, g.last_level, level, price);
        }
        g.last_level = level;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct StopGrid<'info> {
    #[account(mut, has_one = owner)]
    pub grid: Account<'info, GridConfig>,
    pub owner: Signer<'info>,
}

pub fn stop_grid(ctx: Context<StopGrid>) -> Result<()> {
    ctx.accounts.grid.active = false;
    msg!("Grid #{} stopped after {} fills", ctx.accounts.grid.grid_id, ctx.accounts.grid.fills);
    Ok(())
}

/// Delegate the grid + its feed to the rollup (so the crank can tick them).
#[delegate]
#[derive(Accounts)]
#[instruction(grid_id: u64)]
pub struct DelegateGrid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: vault PDA.
    #[account(seeds = [VAULT_SEED, payer.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: grid PDA to delegate.
    #[account(mut, del, seeds = [GRID_SEED, vault.key().as_ref(), &grid_id.to_le_bytes()], bump)]
    pub grid: UncheckedAccount<'info>,
    /// CHECK: grid feed PDA to delegate.
    #[account(mut, del, seeds = [PRICE_SEED, grid.key().as_ref()], bump)]
    pub grid_feed: UncheckedAccount<'info>,
}

pub fn delegate_grid(ctx: Context<DelegateGrid>, grid_id: u64) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let gid = grid_id.to_le_bytes();
    let grid_key = ctx.accounts.grid.key();
    ctx.accounts
        .delegate_grid(&ctx.accounts.payer, &[GRID_SEED, vault_key.as_ref(), &gid], DelegateConfig::default())?;
    ctx.accounts
        .delegate_grid_feed(&ctx.accounts.payer, &[PRICE_SEED, grid_key.as_ref()], DelegateConfig::default())?;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleGridArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[derive(Accounts)]
pub struct ScheduleGrid<'info> {
    /// CHECK: magic program.
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: grid PDA.
    #[account(mut)]
    pub grid: UncheckedAccount<'info>,
    /// CHECK: grid feed PDA.
    pub grid_feed: UncheckedAccount<'info>,
    /// CHECK: this program.
    pub program: UncheckedAccount<'info>,
}

pub fn schedule_grid(ctx: Context<ScheduleGrid>, args: ScheduleGridArgs) -> Result<()> {
    let step_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.grid.key(), false),
            AccountMeta::new_readonly(ctx.accounts.grid_feed.key(), false),
        ],
        data: anchor_lang::InstructionData::data(&crate::instruction::GridStep {}),
    };
    let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id: args.task_id,
        execution_interval_millis: args.execution_interval_millis,
        iterations: args.iterations,
        instructions: vec![step_ix],
    }))
    .map_err(|_| ProgramError::InvalidArgument)?;
    let schedule_ix = Instruction::new_with_bytes(
        MAGIC_PROGRAM_ID,
        &ix_data,
        vec![
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.grid.key(), false),
            AccountMeta::new_readonly(ctx.accounts.grid_feed.key(), false),
        ],
    );
    invoke_signed(
        &schedule_ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.grid.to_account_info(),
            ctx.accounts.grid_feed.to_account_info(),
        ],
        &[],
    )?;
    Ok(())
}
