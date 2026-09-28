import { describe, it, expect } from "vitest";
import { DEFAULT_PRIVACY_PIN, isValidPin, privacyPin, revealNeedsPin } from "./censor";

describe("censor mode PIN", () => {
	it("defaults to 1234", () => {
		expect(DEFAULT_PRIVACY_PIN).toBe("1234");
		expect(privacyPin({})).toBe("1234");
		expect(revealNeedsPin({})).toBe(true);
	});

	it("uses a PIN you set", () => {
		expect(privacyPin({ privacyPin: "0007" })).toBe("0007");
	});

	it("asks for nothing once the PIN is cleared", () => {
		expect(revealNeedsPin({ privacyPin: "" })).toBe(false);
	});

	it("only accepts four digits", () => {
		expect(isValidPin("1234")).toBe(true);
		expect(isValidPin("123")).toBe(false);
		expect(isValidPin("12345")).toBe(false);
		expect(isValidPin("12a4")).toBe(false);
	});
});
