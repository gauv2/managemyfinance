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
