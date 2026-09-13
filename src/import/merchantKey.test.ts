import { describe, it, expect } from "vitest";
import { merchantDisplayName, merchantKey, merchantLabel } from "./merchantKey";

function key(description: string, counterparty?: string): string | undefined {
	return merchantKey({ description, counterparty });
}

describe("merchantKey — grouping the same shop", () => {
	it("groups a merchant across tills, branches and terminals", () => {
		const forms = ["Albert Heijn 5566", "BEA, Betaalpas ALBERT HEIJN", "albert heijn"];
		const keys = forms.map((f) => key(f));
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toBe("albert heijn");
	});

	it("strips dates and times appended by the bank", () => {
		expect(key("Shell Rotterdam 01.02.2026 14:33")).toBe(key("Shell Rotterdam"));
	});

	it("strips card and reference markers", () => {
		expect(key("ALBERT HEIJN/PASVOLGNR 003")).toBe("albert heijn");
		expect(key("Jumbo Kaartnummer 1234")).toBe("jumbo");
	});

	it("drops everything after a comma or slash — usually branch or reference", () => {
		expect(key("Bambu Lab, Shenzhen")).toBe("bambu lab");
		expect(key("Google One/subscription")).toBe("google one");
	});

	it("handles every terminal prefix in the list", () => {
		expect(key("SumUp *Rasoi Indian")).toBe("rasoi indian");
		expect(key("SQ *Coffee Bar")).toBe("coffee bar");
		expect(key("PayPal *Patreon")).toBe("patreon");
	});
});

describe("merchantKey — not over-merging", () => {
	// Over-merging is the dangerous direction: two shops sharing a key mis-files a whole history.
	it("keeps genuinely different merchants apart", () => {
		expect(key("Albert Heijn")).not.toBe(key("Jumbo"));
		expect(key("Bambu Lab")).not.toBe(key("Bambu Garden"));
		expect(key("Google One")).not.toBe(key("Google Cloud"));
	});

	it("keeps distinct brands apart even when they share a first word", () => {
		expect(key("Shell Recharge")).not.toBe(key("Shell Rotterdam Zuid"));
		expect(key("Google One")).not.toBe(key("Google Cloud Platform"));
	});

	it("does not collapse everything unrecognizable into one shared key", () => {
		expect(key("000123456789")).toBeUndefined();
		expect(key("2026-01-08 14:22")).toBeUndefined();
		expect(key("NL12RABO0123456789")).toBeUndefined();
	});
});

describe("merchantKey — refuses rather than guesses", () => {
	it("returns undefined for empty or meaningless input", () => {
		expect(key("")).toBeUndefined();
		expect(key("   ")).toBeUndefined();
		expect(key("BV")).toBeUndefined();
	});

	it("falls back to the counterparty when the description is empty", () => {
		expect(key("", "Koninklijke PostNL B.V.")).toBe("koninklijke postnl");
	});
});

describe("merchantKey — token handling", () => {
	it("drops id-like tokens that are majority digits", () => {
		expect(key("Marktplaats x0042")).toBe("marktplaats");
		expect(key("Store 1423a Amsterdam")).toBe("store amsterdam");
	});

	it("keeps the cleaned name, dropping only branch numbers and refs", () => {
		expect(key("CCV*ALBERT HEIJN 1423 DEN HAAG")).toBe("albert heijn den haag");
		expect(key("Albert Heijn 5566")).toBe("albert heijn");
	});

	it("drops single-letter legal-form debris", () => {
		expect(key("Hoogendoorn Holding B.V.")).toBe("hoogendoorn holding");
	});

	it("keeps accented characters, which Dutch and German merchants use", () => {
		expect(key("Café Zürich")).toBe("café zürich");
	});

	it("is case- and whitespace-insensitive", () => {
		expect(key("  ALBERT   HEIJN  ")).toBe(key("albert heijn"));
	});
});

describe("merchantLabel", () => {
	it("title-cases the key for display", () => {
		expect(merchantLabel("albert heijn")).toBe("Albert Heijn");
		expect(merchantLabel("bambu lab")).toBe("Bambu Lab");
	});

	it("upper-cases short words, which are usually initialisms", () => {
		expect(merchantLabel("kpn nl")).toBe("KPN NL");
	});
});

describe("merchantKey — leading connectives", () => {
	// The bug this exists for: "Transfer from X" reduced to "transfer from", so every transfer in the
	// ledger became one merchant, and the model was asked to classify a preposition.
	it("does not let direction words eat the token budget", () => {
		expect(key("To Koninklijke PostNL B.V.")).toBe("koninklijke postnl");
		expect(key("Transfer from HOOGENDOORN HOLDING BV")).toBe("hoogendoorn holding bv");
		expect(key("To Revolut Bank UAB")).toBe("revolut bank uab");
	});

	it("groups a payee with and without its direction word", () => {
		expect(key("To Koninklijke PostNL")).toBe(key("Koninklijke PostNL"));
	});

	it("keeps distinct transfer counterparties apart", () => {
		expect(key("Transfer from HOOGENDOORN HOLDING BV")).not.toBe(key("Transfer from ACME BV"));
	});

	it("refuses a description that is only connectives", () => {
		expect(key("Transfer from")).toBeUndefined();
		expect(key("payment")).toBeUndefined();
	});
});

describe("merchantDisplayName", () => {
	it("keeps the full readable name rather than the two-token key", () => {
		expect(merchantDisplayName("To Koninklijke PostNL B.V.")).toBe("Koninklijke PostNL B.V.");
		expect(merchantDisplayName("Vats Prague Group")).toBe("Vats Prague Group");
	});

	it("strips terminal prefixes, branch numbers and dates", () => {
		expect(merchantDisplayName("CCV*ALBERT HEIJN 1423 DEN HAAG")).toBe("Albert Heijn Den Haag");
		expect(merchantDisplayName("Shell Rotterdam 01.02.2026 14:33")).toBe("Shell Rotterdam");
	});

	it("un-shouts all-caps bank text", () => {
		expect(merchantDisplayName("HOOGENDOORN HOLDING BV")).toBe("Hoogendoorn Holding BV");
	});

	it("is empty when there is no name in the description at all", () => {
		expect(merchantDisplayName("000123456789")).toBe("");
	});
});

describe("merchantKey — distinct payees must not merge", () => {
	// The regression this guards: a two-token key turned "To Vo Ty Nguyen", "To Vo Ty Tran" and
	// "To Vo Ty Le" into one merchant "vo ty", putting 126 different people in one category.
	it("keeps people who share a surname apart", () => {
		const keys = ["To Vo Ty Nguyen", "To Vo Ty Tran", "To Vo Ty Le"].map((d) => key(d));
		expect(new Set(keys).size).toBe(3);
	});

	it("keeps companies sharing a first word apart", () => {
		expect(key("Nopkt Holding BV")).not.toBe(key("Nopkt Services BV"));
		expect(key("Hotel Amsterdam Zuidas")).not.toBe(key("Hotel Amsterdam Centraal"));
	});

	it("still collapses the same shop across branches with numeric codes", () => {
		expect(key("Albert Heijn 1423")).toBe(key("Albert Heijn 5566"));
	});
});

describe("which field names the payee", () => {
	it("reads the shop off the counterparty when the description is a card-terminal line", () => {
		// KNAB writes "BUNNIK 08-11-2014 16:20 Pas: 4333" as the description and the shop beside it.
		// Keying on the description put 595 unrelated transactions under one merchant called
		// "rotterdam pas" — a city, which no rule and no model could ever categorise.
		expect(merchantKey({ description: "BUNNIK 08-11-2014 16:20 Pas: 4333", counterparty: "Albert Heijn Bunnik" })).toBe(
			"albert heijn bunnik"
		);
		expect(merchantKey({ description: "ROTTERDAM 10-01-2015 19:13 Pas: 4333", counterparty: "Eetcafe P.Alexander" })).toBe(
			"eetcafe alexander"
		);
	});

	it("keeps two shops in the same city apart", () => {
		const a = merchantKey({ description: "ROTTERDAM 10-01-2015 19:13 Pas: 4333", counterparty: "Jumbo Rotterdam" });
		const b = merchantKey({ description: "ROTTERDAM 11-01-2015 09:02 Pas: 4333", counterparty: "Kruidvat 0272" });
		expect(a).not.toBe(b);
	});

	it("still prefers the description where that is the merchant", () => {
		// The banks this was written for put the merchant in the description and nothing useful beside it.
		expect(merchantKey({ description: "ALBERT HEIJN 1423 DEN HAAG" })).toBe(
			merchantKey({ description: "ALBERT HEIJN 1423 DEN HAAG", counterparty: "" })
		);
	});

	it("ignores a counterparty that is an account number rather than a name", () => {
		// Banks like ING put an IBAN there; keying on it would file the same shop differently every
		// time it billed from another account.
		const key = merchantKey({ description: "UTRECHT 08-11-2014 15:08 Pas: 4333", counterparty: "NL04RABO0356343936" });
		expect(key).not.toBe("nl04rabo0356343936");
	});

	it("falls back to the counterparty when the description names nobody", () => {
		// "2014-0051" is a reference, not a merchant. Giving up here left 232 rows of one import with
		// no merchant identity at all, so they reached neither the rules nor the model.
		expect(merchantKey({ description: "2014-0051", counterparty: "Snowcone B.V." })).toBe("snowcone");
	});

	it("is still undefined when neither field names anyone", () => {
		expect(merchantKey({ description: "2014-0051", counterparty: "" })).toBeUndefined();
		expect(merchantKey({ description: "", counterparty: "" })).toBeUndefined();
	});
});

describe("administrative words are not a merchant", () => {
	it("does not build a key out of reference vocabulary", () => {
		// "Kenmerk … Omschrijving Klantnummer" is an invoice reference; Eneco is in the next column.
		expect(merchantKey({ description: "Kenmerk  8002227925600011 Omschrijving  Klantnummer", counterparty: "ENECO SERVICES" })).toBe(
			"eneco services"
		);
		expect(merchantKey({ description: "kenmerk 3021601156831408 Rel.nr. 436815672 Periode 0", counterparty: "CZ Groep Zorgverzekeraar" })).toBe(
			"cz groep zorgverzekeraar"
		);
	});

	it("stops different companies merging under the word their description opened with", () => {
		// Six payees, XS4ALL and A.T.O. Electro among them, were all filed under "factuurnummer".
		const a = merchantKey({ description: "Factuurnummer 201623896", counterparty: "XS4ALL" });
		const b = merchantKey({ description: "Factuurnummer 900012345", counterparty: "A.T.O. Electro B.V." });
		expect(a).not.toBe(b);
		expect(a).toBe("xs4all");
	});

	it("leaves a real name that merely contains a reference word alone", () => {
		// Only whole tokens are dropped, so a trading name survives intact.
		expect(merchantKey({ description: "Nummer Vijf Cafe" })).toContain("vijf");
	});

	it("still returns nothing when the description is only admin words and there is no counterparty", () => {
		expect(merchantKey({ description: "Factuurnummer 201623896", counterparty: "" })).toBeUndefined();
	});
});
