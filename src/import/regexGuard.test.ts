import { describe, expect, it } from "vitest";
import { ruleMatches, unsafeRegexReason } from "./categorize";

describe("patterns that would never finish", () => {
	it("refuses a nested quantifier instead of running it", () => {
		// Measured unguarded: "(a+)+$" against an almost-matching string costs 18ms at 18 characters
		// and 160ms at 24 — doubling every two. At the length of a real bank description it does not
		// return, and the rule dialog re-runs the pattern over the whole ledger on every keystroke, so
		// typing one freezes the window with no dialog left to cancel.
		const tx = { description: "a".repeat(40) + "!", counterparty: "" };
		const start = Date.now();
		expect(ruleMatches(tx, { pattern: "(a+)+$", isRegex: true })).toBe(false);
		expect(Date.now() - start).toBeLessThan(200);
	});

	it("names the shapes it will not run", () => {
		expect(unsafeRegexReason("(a+)+")).toBeTruthy();
		expect(unsafeRegexReason("(\\d*)*")).toBeTruthy();
		expect(unsafeRegexReason("(ab+)*")).toBeTruthy();
		expect(unsafeRegexReason("(a+){3}")).toBeTruthy();
	});

	it("leaves ordinary patterns alone", () => {
		// A shape test, not a proof — it must not start refusing the regexes people actually write.
		expect(unsafeRegexReason("^ns\\s")).toBeUndefined();
		expect(unsafeRegexReason("albert.*heijn")).toBeUndefined();
		expect(unsafeRegexReason("(albert|jumbo)")).toBeUndefined();
		expect(unsafeRegexReason("\\d{4}-\\d{2}")).toBeUndefined();
		expect(ruleMatches({ description: "NS REIZIGERS" }, { pattern: "^ns\\s", isRegex: true })).toBe(true);
	});
});
