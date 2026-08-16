import { describe, it, expect } from "vitest";
import { attachmentFolderOf } from "./attachments";

describe("attachmentFolderOf", () => {
	it("keeps receipts beside the ledger when nothing is configured", () => {
		expect(attachmentFolderOf({ dataFolder: "Manage My Finance" })).toBe("Manage My Finance/attachments");
	});

	it("follows the data folder rather than freezing a path, when left blank", () => {
		// Blank must mean "the default", so moving the data folder moves attachments with it.
		expect(attachmentFolderOf({ dataFolder: "System/Finance", attachmentFolder: "" })).toBe("System/Finance/attachments");
		expect(attachmentFolderOf({ dataFolder: "System/Finance", attachmentFolder: "   " })).toBe("System/Finance/attachments");
	});

	it("uses a custom folder anywhere in the vault, not just under the data folder", () => {
		expect(attachmentFolderOf({ dataFolder: "Manage My Finance", attachmentFolder: "90 Archive/Receipts" })).toBe("90 Archive/Receipts");
	});

	it("normalises a path typed with a stray leading or trailing slash", () => {
		expect(attachmentFolderOf({ dataFolder: "Finance", attachmentFolder: "Documents/Receipts/" })).toBe("Documents/Receipts");
	});
});
