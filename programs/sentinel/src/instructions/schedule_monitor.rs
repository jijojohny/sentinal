use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleMonitorArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

/// Schedule the `evaluate` crank to run automatically in the rollup. After this
/// one transaction, the guard is monitored every `execution_interval_millis`
/// with no further client calls — the "no server" core of Sentinel.
#[derive(Accounts)]
pub struct ScheduleMonitor<'info> {
    /// CHECK: MagicBlock magic program, used for the ScheduleTask CPI.
    pub magic_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: guard PDA, passed through to the scheduled instruction.
    #[account(mut)]
    pub guard: UncheckedAccount<'info>,

    /// CHECK: price-feed PDA, read by the scheduled instruction.
    pub price_feed: UncheckedAccount<'info>,

    /// CHECK: this program, target of the scheduled instruction.
    pub program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ScheduleMonitor>, args: ScheduleMonitorArgs) -> Result<()> {
    let evaluate_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.guard.key(), false),
            AccountMeta::new_readonly(ctx.accounts.price_feed.key(), false),
        ],
        data: anchor_lang::InstructionData::data(&crate::instruction::Evaluate {}),
    };

    let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id: args.task_id,
        execution_interval_millis: args.execution_interval_millis,
        iterations: args.iterations,
        instructions: vec![evaluate_ix],
    }))
    .map_err(|err| {
        msg!("ERROR: failed to serialize schedule args {:?}", err);
        ProgramError::InvalidArgument
    })?;

    let schedule_ix = Instruction::new_with_bytes(
        MAGIC_PROGRAM_ID,
        &ix_data,
        vec![
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.guard.key(), false),
            AccountMeta::new_readonly(ctx.accounts.price_feed.key(), false),
        ],
    );

    invoke_signed(
        &schedule_ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.guard.to_account_info(),
            ctx.accounts.price_feed.to_account_info(),
        ],
        &[],
    )?;

    msg!(
        "Scheduled monitor: every {}ms x {} iterations",
        args.execution_interval_millis,
        args.iterations
    );
    Ok(())
}
