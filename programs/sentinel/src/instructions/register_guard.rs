use anchor_lang::prelude::*;
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

use crate::constants::{GUARD_SEED, PRICE_SEED, VAULT_SEED};
use crate::state::{ActionType, GuardConfig, GuardKind, PriceFeed, RuleType, TRIP_NONE};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterGuardParams {
    pub guard_id: u64, // which guard within the vault (multi-position registry)
    pub market: Pubkey,
    pub side: u8,
    pub rule: RuleType,
    pub action: ActionType,
    pub kind: GuardKind,        // Protect (exit) or Entry (limit order)
    pub trigger_price: u64,
    pub trail_distance: u64,    // 0 for fixed rules; >0 for TrailingStop
    pub tp_price: u64,          // OCO take-profit (0 = none)
    pub breakeven_offset: u64,  // 0 = off
    pub expiry_ts: i64,         // 0 = no time exit
    pub margin_amount: u64,     // AddMargin action: collateral to add
    pub keeper_bounty: u64,     // lamports paid to whoever lands settlement
    pub vol_k: u64,             // vol-scaled trail factor in bps (0 = off)
    pub entry_size: u64,        // Entry kind: size to open / total size for ladders
    pub entry_collateral: u64,  // Entry kind: collateral to open with
    pub tp_ladder: [u64; 3],    // scale-out rungs (ascending; 0 = unused)
    pub bracket_stop: u64,      // Entry kind: auto-armed stop on fill (0 = none)
    pub settle_delay: i64,      // anti-MEV settle-lock seconds (0 = off)
    pub close_price_limit: u64,
    pub initial_price: u64,
}

/// Register a protection rule, keyed by `guard_id` (one vault → many guards).
///
/// Session-key aware: the `authority` is the trader's wallet (owns the vault +
/// guard), but the actual `payer`/signer may be a scoped **session key**. With a
/// valid `session_token`, a trader can arm/manage guards without their wallet
/// online; without one, the wallet must sign (authority == payer).
#[derive(Accounts, Session)]
#[instruction(params: RegisterGuardParams)]
pub struct RegisterGuard<'info> {
    /// CHECK: the trader's wallet — owns the vault & guard (vault seed authority).
    pub authority: UncheckedAccount<'info>,

    /// CHECK: data-less vault PDA (the Flash position owner / signer).
    #[account(seeds = [VAULT_SEED, authority.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = GuardConfig::LEN,
        seeds = [GUARD_SEED, vault.key().as_ref(), &params.guard_id.to_le_bytes()],
        bump
    )]
    pub guard: Account<'info, GuardConfig>,

    #[account(
        init,
        payer = payer,
        space = PriceFeed::LEN,
        seeds = [PRICE_SEED, vault.key().as_ref(), &params.guard_id.to_le_bytes()],
        bump
    )]
    pub price_feed: Account<'info, PriceFeed>,

    /// The actor paying + signing — the wallet itself, or a scoped session key.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Optional session token authorizing `payer` to act for `authority`.
    #[session(signer = payer, authority = authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,

    pub system_program: Program<'info, System>,
}

#[session_auth_or(
    ctx.accounts.authority.key() == ctx.accounts.payer.key(),
    SessionError::InvalidToken
)]
pub fn handler(ctx: Context<RegisterGuard>, params: RegisterGuardParams) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let guard = &mut ctx.accounts.guard;
    guard.vault = ctx.accounts.vault.key();
    guard.owner = authority;
    guard.market = params.market;
    guard.guard_id = params.guard_id;
    guard.side = params.side;
    guard.rule = params.rule;
    guard.action = params.action;
    guard.entry_price = params.initial_price;
    guard.trigger_price = params.trigger_price;
    guard.trail_distance = params.trail_distance;
    guard.tp_price = params.tp_price;
    guard.breakeven_offset = params.breakeven_offset;
    guard.expiry_ts = params.expiry_ts;
    guard.margin_amount = params.margin_amount;
    guard.close_price_limit = params.close_price_limit;
    guard.last_price = params.initial_price;
    guard.high_water = params.initial_price;
    guard.triggered = false;
    guard.executed = false;
    guard.active = true;
    guard.breakeven_armed = false;
    guard.trip_reason = TRIP_NONE;
    guard.kind = params.kind;
    guard.keeper_bounty = params.keeper_bounty;
    guard.vol_k = params.vol_k;
    guard.entry_size = params.entry_size;
    guard.entry_collateral = params.entry_collateral;
    guard.tp_ladder = params.tp_ladder;
    guard.ladder_done = 0;
    guard.bracket_stop = params.bracket_stop;
    guard.settle_delay = params.settle_delay;
    guard.settle_after_ts = 0;
    guard.bump = ctx.bumps.guard;

    let feed = &mut ctx.accounts.price_feed;
    feed.market = params.market;
    feed.price = params.initial_price;
    feed.ts = Clock::get()?.unix_timestamp;
    feed.bump = ctx.bumps.price_feed;
    feed.record(params.initial_price);

    msg!(
        "Guard #{} registered for {}: rule={:?} action={:?} trigger={} tp={}",
        guard.guard_id,
        authority,
        guard.rule,
        guard.action,
        guard.trigger_price,
        guard.tp_price
    );
    Ok(())
}
