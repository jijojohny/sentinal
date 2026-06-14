use anchor_lang::prelude::*;

use crate::constants::STRATEGY_SEED;
use crate::state::{ActionType, RuleType, Strategy};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PublishStrategyParams {
    pub strategy_id: u64,
    pub rule: RuleType,
    pub action: ActionType,
    pub side: u8,
    pub stop_offset: u64,
    pub tp_offset: u64,
    pub trail_distance: u64,
    pub breakeven_offset: u64,
    pub margin_amount: u64,
    pub fee_lamports: u64,
}

/// A leader publishes a reusable strategy template (offsets from entry). Followers
/// instantiate their own guards from it via `follow_strategy`.
#[derive(Accounts)]
#[instruction(params: PublishStrategyParams)]
pub struct PublishStrategy<'info> {
    #[account(
        init,
        payer = leader,
        space = Strategy::LEN,
        seeds = [STRATEGY_SEED, leader.key().as_ref(), &params.strategy_id.to_le_bytes()],
        bump
    )]
    pub strategy: Account<'info, Strategy>,

    #[account(mut)]
    pub leader: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PublishStrategy>, params: PublishStrategyParams) -> Result<()> {
    let s = &mut ctx.accounts.strategy;
    s.leader = ctx.accounts.leader.key();
    s.strategy_id = params.strategy_id;
    s.rule = params.rule;
    s.action = params.action;
    s.side = params.side;
    s.stop_offset = params.stop_offset;
    s.tp_offset = params.tp_offset;
    s.trail_distance = params.trail_distance;
    s.breakeven_offset = params.breakeven_offset;
    s.margin_amount = params.margin_amount;
    s.fee_lamports = params.fee_lamports;
    s.followers = 0;
    s.bump = ctx.bumps.strategy;
    msg!("Strategy #{} published by {}", s.strategy_id, s.leader);
    Ok(())
}
