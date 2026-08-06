export type AccountType = "debit" | "credit" | "investing" | "saving" | "cash";

export interface Account {
	id: string;
	name: string;
	institution?: string;
	type: AccountType;
	currency: string;
	openingBalance?: number;
	openingDate?: string;
}

export interface Category {
	id: string;
	name: string;
	color: string;
	icon: string;
	aliases: string[];
	budget?: number;
	archived?: boolean;
}

export interface CategoryRule {
	id: string;
	pattern: string;
	isRegex?: boolean;
	categoryId: string;
}

export type TransactionSource = "ing" | "trade-republic" | "generic" | "manual";

export interface Transaction {
	id: string;
	date: string;
	accountId: string;
	description: string;
	counterparty?: string;
	amount: number;
	currency: string;
	categoryId?: string;
	type?: string;
	source: TransactionSource;
	raw?: string;
	notes?: string;
	ticker?: string;
	assetClass?: string;
	shares?: number;
	price?: number;
	fee?: number;
	tax?: number;
	action?: string;
}
