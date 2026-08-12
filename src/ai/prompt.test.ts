import { describe, it, expect } from "vitest";
import { buildUserPrompt, categoryOptions, extractJson, validateAssignments } from "./prompt";
import type { Category } from "../types";

const FOOD: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const GROCERIES: Category = { id: "cat-groceries", name: "Groceries", color: "#000", icon: "cart", aliases: [], parentId: "cat-food" };
const CAR: Category = { id: "cat-car", name: "Auto & Transport", color: "#000", icon: "car", aliases: [] };
const OLD: Category = { id: "cat-old", name: "Retired", color: "#000", icon: "x", aliases: [], archived: true };
const categories = [FOOD, GROCERIES, CAR, OLD];

describe("categoryOptions", () => {
	it("lists every primary and its secondaries as a path", () => {
		expect(categoryOptions(categories)).toEqual([
			{ id: "cat-food", path: "Food" },
			{ id: "cat-groceries", path: "Food > Groceries" },
			{ id: "cat-car", path: "Auto & Transport" },
		]);
	});

	it("omits archived categories, which must never be assigned", () => {
		expect(categoryOptions(categories).some((o) => o.id === "cat-old")).toBe(false);
	});
});

describe("buildUserPrompt", () => {
	it("contains the merchants and the id-to-path tree, and nothing else about the vault", () => {
		const prompt = buildUserPrompt(["bambu lab", "albert heijn"], categories);
		expect(prompt).toContain("bambu lab");
		expect(prompt).toContain("cat-groceries\tFood > Groceries");
		// The payload promise: no amounts, dates, accounts or balances anywhere in it.
		expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(prompt).not.toMatch(/EUR|IBAN|NL\d{2}/);
	});
});

describe("extractJson", () => {
	it("parses a bare object", () => {
		expect(extractJson('{"assignments":[]}')).toEqual({ assignments: [] });
	});

	it("parses a fenced block, which the CLI transport commonly returns", () => {
		expect(extractJson('```json\n{"assignments":[]}\n```')).toEqual({ assignments: [] });
		expect(extractJson("```\n{\"assignments\":[]}\n```")).toEqual({ assignments: [] });
	});

	it("survives a leading sentence of commentary", () => {
		expect(extractJson('Here are the results:\n{"assignments":[]}')).toEqual({ assignments: [] });
	});

	it("throws a readable error when there is no JSON at all", () => {
		expect(() => extractJson("I cannot help with that.")).toThrow(/no JSON object/);
	});

	it("throws when the JSON is malformed rather than returning junk", () => {
		expect(() => extractJson('{"assignments": [oops}')).toThrow(/couldn't be parsed/);
	});
});

describe("validateAssignments — the guardrail", () => {
	const asked = ["bambu lab", "albert heijn"];

	it("accepts a well-formed answer", () => {
		const { assignments, rejected } = validateAssignments(
			{ assignments: [{ merchant: "albert heijn", categoryId: "cat-groceries", confidence: 0.95 }] },
			asked,
			categories
		);
		expect(rejected).toEqual([]);
		expect(assignments).toEqual([{ merchant: "albert heijn", categoryId: "cat-groceries", confidence: 0.95 }]);
	});

	it("rejects a hallucinated category id", () => {
		// The failure this exists to prevent: an id nothing resolves reads as "Uncategorized"
		// everywhere while being invisible to an uncategorized filter, so the spend vanishes.
		const { assignments, rejected } = validateAssignments(
			{ assignments: [{ merchant: "bambu lab", categoryId: "cat-3d-printing", confidence: 0.9 }] },
			asked,
			categories
		);
		expect(assignments).toEqual([]);
		expect(rejected[0].reason).toContain("unknown category");
	});

	it("rejects an archived category", () => {
		const { assignments } = validateAssignments(
			{ assignments: [{ merchant: "bambu lab", categoryId: "cat-old", confidence: 0.9 }] },
			asked,
			categories
		);
		expect(assignments).toEqual([]);
	});

	it("rejects a merchant we never asked about", () => {
		const { rejected } = validateAssignments(
			{ assignments: [{ merchant: "netflix", categoryId: "cat-food", confidence: 0.9 }] },
			asked,
			categories
		);
		expect(rejected[0].reason).toContain("not a merchant we asked about");
	});

	it("keeps only the first answer when a merchant is answered twice", () => {
		const { assignments, rejected } = validateAssignments(
			{
				assignments: [
					{ merchant: "bambu lab", categoryId: "cat-food", confidence: 0.9 },
					{ merchant: "bambu lab", categoryId: "cat-car", confidence: 0.8 },
				],
			},
			asked,
			categories
		);
		expect(assignments).toHaveLength(1);
		expect(assignments[0].categoryId).toBe("cat-food");
		expect(rejected[0].reason).toBe("duplicate answer");
	});

	it("matches merchants case-insensitively", () => {
		const { assignments } = validateAssignments(
			{ assignments: [{ merchant: "Albert Heijn", categoryId: "cat-food", confidence: 0.9 }] },
			asked,
			categories
		);
		expect(assignments[0].merchant).toBe("albert heijn");
	});

	it("clamps confidence into range and treats a missing one as zero", () => {
		const { assignments } = validateAssignments(
			{
				assignments: [
					{ merchant: "bambu lab", categoryId: "cat-food", confidence: 7 },
					{ merchant: "albert heijn", categoryId: "cat-food" },
				],
			},
			asked,
			categories
		);
		expect(assignments[0].confidence).toBe(1);
		expect(assignments[1].confidence).toBe(0);
	});

	it("throws when the reply has no assignments list", () => {
		expect(() => validateAssignments({ result: "ok" }, asked, categories)).toThrow(/no "assignments" list/);
	});

	it("tolerates an empty list — omitting an unrecognizable merchant is a valid answer", () => {
		expect(validateAssignments({ assignments: [] }, asked, categories).assignments).toEqual([]);
	});
});
