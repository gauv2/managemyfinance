import { amountIn, netWorthAsOf, type KpiStore } from "./kpi";
import { addDaysIso } from "./recurring";

/**
 * One account's balance through one month, day by day, for the Cash flow page's credit card chart:
 * what was spent on it, what was paid off, what's still owed, and where the biggest payment landed.
 *
 * The balance is netWorthAsOf for the account on each day, so it matches the account's own page to
 * the cent. Days after today repeat today's balance — nothing has happened yet to move it.
 */

export interface AccountMonth {
	days: string[];
	balances: number[];
	/** Index into `days` of today, when today falls in the month. */
	todayIndex?: number;
	/** Money out, positive. */
	spent: number;
	/** Money in — a card payment, a refund. */
	paid: number;
	/** The balance on the last day that has happened. Negative is owed on a card. */
	balance: number;
	biggestPayment?: { index: number; amount: number };
}

export function accountMonth(store: KpiStore, accountId: string, month: string, today: string): AccountMonth {
	const [y, m] = month.split("-").map(Number);
	const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
	const days = Array.from({ length: dim }, (_, i) => addDaysIso(`${month}-01`, i));

	const balances: number[] = [];
	for (const day of days) {
		balances.push(day <= today || balances.length === 0 ? netWorthAsOf(store, day <= today ? day : today, accountId) : balances[balances.length - 1]);
	}

	let spent = 0;
	let paid = 0;
	let biggestPayment: AccountMonth["biggestPayment"];
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId || !tx.date || !tx.date.startsWith(month)) continue;
		const amount = amountIn(store, tx);
		if (amount < 0) spent -= amount;
		else {
			paid += amount;
			if (!biggestPayment || amount > biggestPayment.amount) biggestPayment = { index: Number(tx.date.slice(8, 10)) - 1, amount };
		}
	}

	const todayIndex = today.startsWith(month) ? Number(today.slice(8, 10)) - 1 : undefined;
	const lastHappened = todayIndex ?? (days[0] > today ? 0 : dim - 1);
	return { days, balances, todayIndex, spent, paid, balance: balances[lastHappened], biggestPayment };
}
