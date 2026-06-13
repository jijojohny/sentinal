use anchor_lang::prelude::*;

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const GUARD_SEED: &[u8] = b"guard";

#[constant]
pub const PRICE_SEED: &[u8] = b"price";

/// Flash Trade perpetuals program id (flash-trade/flash-perpetuals).
/// The Flash program is passed as an account to `execute_protection` and checked
/// against this id; redeploys on localnet can override the check via the account.
#[constant]
pub const FLASH_PROGRAM_ID: Pubkey = pubkey!("Bmr31xzZYYVUdoHmAJL1DAp2anaitW8Tw9YfASS94MKJ");
