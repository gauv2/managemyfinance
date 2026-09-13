import type { Account } from "./types";

/**
 * The accounts worth offering when the question is about activity that hasn't happened yet.
 *
 * A closed account is presentation-only everywhere else — its transactions, balances and reports are
 * untouched by the flag (see `Account.archived`) — but there is one place the distinction genuinely
 * matters: a picker asking where *future* money will move. A cancelled card can't hold a new
 * subscription, a closed savings account can't be a goal's destination, and a schedule can't fire
 * into an account that no longer exists.
 *
 * Deliberately not applied to the historical pickers. Importing years of statements into an account
 * you closed last month is exactly what the flag exists to support, and re-filing an old row still
 * has to be able to name the account it actually belonged to — so the import wizard, the transaction
 * editor and the balance-snapshot dialog keep offering everything.
 *
 * `keepId` keeps whatever is already selected in the list, so opening an old record that points at a
 * since-closed account doesn't silently re-point it at a different one.
 */
export function activeAccounts(accounts: Account[], keepId?: string): Account[] {
	return accounts.filter((a) => !a.archived || a.id === keepId);
}

/**
 * Does this account keep a running balance?
 *
 * Absent means yes, so every account written before the option existed keeps behaving exactly as it
 * did. Read through this helper rather than testing the field, so "not set" can never be mistaken for
 * "not tracked" at one call site out of eight.
 */
export function tracksBalance(account: Pick<Account, "trackBalance">): boolean {
	return account.trackBalance !== false;
}
