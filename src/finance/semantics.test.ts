import { describe, expect, it } from "vitest";
import { classifyTransaction, isEconomicallyNeutral, type ClassifyStore } from "./semantics";
import type { Account, Category, Transaction } from "../types";

const checking: Account = { id: "checking", name: "Checking", type: "debit", currency: "EUR" };
const savings: Account = { id: "savings", name: "Savings", type: "saving", currency: "EUR" };
const investing: Account = { id: "investing", name: "Investing", type: "investing", currency: "EUR" };
const crypto: Account = { id: "crypto", name: "Crypto", type: "crypto", currency: "EUR" };
const creditCard: Account = { id: "credit", name: "Credit card", type: "credit", currency: "EUR" };
const loan: Account = { id: "loan", name: "Loan", type: "loan", currency: "EUR" };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catIncome: Category = { id: "cat-income", name: "Income", color: "#000", icon: "coins", aliases: [], kind: "income" };
const catTransfers: Category = { id: "cat-transfers", name: "Transfers", color: "#000", icon: "arrow", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "accountId" | "amount">): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, description: "test", currency: "EUR", source: "manual", ...partial };
}

function store(overrides: Partial<ClassifyStore> = {}): ClassifyStore {
	return { accounts: [checking, savings, investing, crypto, creditCard, loan], categories: [catFood, catIncome, catTransfers], ...overrides };
}

describe("classifyTransaction — internal transfers", () => {
	it("classifies a linked transferGroupId as internal-transfer with explicit confidence", () => {
		const t = tx({ date: "2024-01-01", accountId: checking.id, amount: -500, transferGroupId: "g1" });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("internal-transfer");
		expect(c.confidence).toBe("explicit");
		expect(c.isInternalTransfer).toBe(true);
		expect(c.affectsIncome).toBe(0);
		expect(c.affectsExpense).toBe(0);
	});

	it("classifies a category named Transfers/Savings (case-insensitive) as internal-transfer", () => {
		const weird: Category = { ...catTransfers, id: "cat-weird", name: "  SAVINGS & TRANSFERS  " };
		const t = tx({ date: "2024-01-01", accountId: checking.id, amount: 100, categoryId: weird.id });
		const c = classifyTransaction(store({ categories: [weird] }), t);
		expect(c.kind).toBe("internal-transfer");
	});

	it("classifies a savings account's deposit/withdraw action as internal-transfer", () => {
		const t = tx({ date: "2024-01-01", accountId: savings.id, amount: 500, action: "deposit" });
		expect(classifyTransaction(store(), t).kind).toBe("internal-transfer");
	});
});

describe("classifyTransaction — trades (FIN-004: investing AND crypto)", () => {
	it("classifies a buy in an investing account as investment-buy, not an expense", () => {
		const t = tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy" });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("investment-buy");
		expect(c.affectsExpense).toBe(0);
		expect(isEconomicallyNeutral(c)).toBe(true);
	});

	it("classifies a sell in an investing account as investment-sell, not income", () => {
		const t = tx({ date: "2024-01-01", accountId: investing.id, amount: 1200, action: "sell" });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("investment-sell");
		expect(c.affectsIncome).toBe(0);
	});

	it("classifies a buy in a crypto account as investment-buy — no longer investing-only", () => {
		const t = tx({ date: "2024-01-01", accountId: crypto.id, amount: -1000, action: "buy" });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("investment-buy");
		expect(isEconomicallyNeutral(c)).toBe(true);
	});

	it("classifies a sell in a crypto account as investment-sell — no gross income of the proceeds", () => {
		const t = tx({ date: "2024-01-01", accountId: crypto.id, amount: 1200, action: "sell" });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("investment-sell");
		expect(c.affectsIncome).toBe(0);
	});

	it("a sell mis-categorized under an income-kind category still classifies as investment-sell (account+action evidence wins)", () => {
		const t = tx({ date: "2024-01-01", accountId: investing.id, amount: 2500, action: "sell", categoryId: catIncome.id });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("investment-sell");
		expect(c.affectsIncome).toBe(0);
	});
});

describe("classifyTransaction — dividends, interest, rewards", () => {
	it("classifies a dividend action as dividend income", () => {
		const t = tx({ date: "2024-01-01", accountId: investing.id, amount: 25, action: "dividend" });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("dividend");
		expect(c.affectsIncome).toBe(25);
	});

	it("classifies an interest action as interest income", () => {
		const t = tx({ date: "2024-01-01", accountId: crypto.id, amount: 5, action: "interest" });
		expect(classifyTransaction(store(), t).kind).toBe("interest-income");
	});

	it("classifies a saveback reward as income", () => {
		const t = tx({ date: "2024-01-01", accountId: investing.id, amount: 2, action: "saveback" });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("income");
		expect(c.affectsIncome).toBe(2);
	});
});

describe("classifyTransaction — debt (FIN-012 groundwork)", () => {
	it("classifies a credit-card payment (positive amount) as debt-principal, not income", () => {
		const t = tx({ date: "2024-01-01", accountId: creditCard.id, amount: 500 });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("debt-principal");
		expect(c.affectsIncome).toBe(0);
		expect(isEconomicallyNeutral(c)).toBe(true);
	});

	it("classifies a loan repayment (positive amount) as debt-principal", () => {
		const t = tx({ date: "2024-01-01", accountId: loan.id, amount: 700 });
		expect(classifyTransaction(store(), t).kind).toBe("debt-principal");
	});

	it("still classifies a card purchase (negative amount) as an ordinary expense", () => {
		const t = tx({ date: "2024-01-01", accountId: creditCard.id, amount: -80, categoryId: catFood.id });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("expense");
		expect(c.affectsExpense).toBe(80);
	});

	it("classifies a merchant refund credited back onto a credit card as a refund, not debt-principal (rule 6 must run before rule 7)", () => {
		const t = tx({ date: "2024-01-01", accountId: creditCard.id, amount: 25, categoryId: catFood.id });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("refund");
		expect(c.affectsExpense).toBe(-25);
		expect(c.affectsIncome).toBe(0);
	});

	it("still classifies an uncategorized credit-card credit as debt-principal when there's no refund evidence", () => {
		const t = tx({ date: "2024-01-01", accountId: creditCard.id, amount: 500 });
		expect(classifyTransaction(store(), t).kind).toBe("debt-principal");
	});
});

describe("classifyTransaction — refunds and income", () => {
	it("classifies a positive amount into a non-income category as a refund, reducing expense", () => {
		const t = tx({ date: "2024-01-01", accountId: checking.id, amount: 40, categoryId: catFood.id });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("refund");
		expect(c.affectsExpense).toBe(-40);
		expect(c.affectsIncome).toBe(0);
	});

	it("classifies a positive amount into an income-kind category as income", () => {
		const t = tx({ date: "2024-01-01", accountId: checking.id, amount: 3000, categoryId: catIncome.id });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("income");
		expect(c.affectsIncome).toBe(3000);
	});

	it("falls back to plain sign semantics with ambiguous confidence when there's no evidence at all", () => {
		const t = tx({ date: "2024-01-01", accountId: checking.id, amount: 100 });
		const c = classifyTransaction(store({ categories: [] }), t);
		expect(c.kind).toBe("income");
		expect(c.confidence).toBe("ambiguous");
	});

	it("falls back to expense with derived confidence when a category exists but grants no special kind", () => {
		const t = tx({ date: "2024-01-01", accountId: checking.id, amount: -40, categoryId: catFood.id });
		const c = classifyTransaction(store(), t);
		expect(c.kind).toBe("expense");
		expect(c.confidence).toBe("derived");
	});
});

describe("classifyTransaction — cashMovement always reflects the raw amount", () => {
	it("keeps cashMovement equal to the transaction's own signed amount regardless of kind", () => {
		const t = tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy" });
		expect(classifyTransaction(store(), t).cashMovement).toBe(-1000);
	});
});
