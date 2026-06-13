pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DhQechQHWUwhtDfVCDa5oBjjeq955iB8YMNrH5TrTBPF");

/// Sentinel — a non-custodial, on-chain liquidation & stop-loss guardian for
/// Flash Trade, powered by MagicBlock Ephemeral Rollups.
///
/// Flow:
///   1. initialize_vault   (base)  — vault PDA becomes the Flash position owner
///   2. register_guard     (base)  — store the rule + create the price feed
///   3. delegate_guard     (base)  — delegate guard + price feed to the rollup
///   4. schedule_monitor   (rollup)— schedule the crank: no server from here on
///   5. push_price         (rollup)— Pyth Lazer / demo feed updates, gasless
///   6. evaluate           (rollup)— crank flips `triggered` when the rule trips
///   7. commit_guard       (rollup)— commit + undelegate the triggered guard
///   8. execute_protection (base)  — permissionless CPI to Flash close_position
#[ephemeral]
#[program]
pub mod sentinel {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        instructions::initialize_vault::handler(ctx)
    }

    pub fn register_guard(ctx: Context<RegisterGuard>, params: RegisterGuardParams) -> Result<()> {
        instructions::register_guard::handler(ctx, params)
    }

    pub fn open_protected_position<'info>(
        ctx: Context<'info, OpenProtectedPosition<'info>>,
        params: OpenProtectedParams,
    ) -> Result<()> {
        instructions::open_protected_position::handler(ctx, params)
    }

    pub fn delegate_guard(ctx: Context<DelegateGuard>) -> Result<()> {
        instructions::delegate_guard::handler(ctx)
    }

    pub fn schedule_monitor(ctx: Context<ScheduleMonitor>, args: ScheduleMonitorArgs) -> Result<()> {
        instructions::schedule_monitor::handler(ctx, args)
    }

    pub fn push_price(ctx: Context<PushPrice>, price: u64, ts: i64) -> Result<()> {
        instructions::push_price::handler(ctx, price, ts)
    }

    pub fn evaluate(ctx: Context<Evaluate>) -> Result<()> {
        instructions::evaluate::handler(ctx)
    }

    pub fn commit_guard(ctx: Context<CommitGuard>) -> Result<()> {
        instructions::commit_guard::handler(ctx)
    }

    pub fn execute_protection<'info>(
        ctx: Context<'info, ExecuteProtection<'info>>,
    ) -> Result<()> {
        instructions::execute_protection::handler(ctx)
    }
}
