import { describe, expect, it } from "vitest";
import {
	base64urlToBytes,
	bytesToBase64url,
	randomToken,
	sha256Base64url,
} from "./crypto.ts";
import {
	generateSecret,
	mnemonicForSecret,
	secretFromMnemonic,
} from "./identity.ts";

describe("crypto helpers", () => {
	it("round-trips base64url", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
		expect(base64urlToBytes(bytesToBase64url(bytes))).toEqual(bytes);
	});

	it("produces URL-safe tokens (no +/=)", () => {
		for (let i = 0; i < 50; i++) {
			expect(randomToken()).not.toMatch(/[+/=]/);
		}
	});

	it("hashes deterministically", async () => {
		expect(await sha256Base64url("hello")).toBe(await sha256Base64url("hello"));
		expect(await sha256Base64url("hello")).not.toBe(
			await sha256Base64url("world"),
		);
	});
});

describe("recovery phrase", () => {
	it("generates a 24-word phrase that recovers the same secret", () => {
		const { secret, mnemonic } = generateSecret();
		expect(mnemonic.split(" ")).toHaveLength(24);
		expect(secretFromMnemonic(mnemonic)).toBe(secret);
	});

	it("derives the phrase back from a stored secret", () => {
		const { secret, mnemonic } = generateSecret();
		expect(mnemonicForSecret(secret)).toBe(mnemonic);
	});

	it("normalizes casing and whitespace", () => {
		const { secret, mnemonic } = generateSecret();
		const messy = `  ${mnemonic.toUpperCase().replace(/ /g, "   ")}  `;
		expect(secretFromMnemonic(messy)).toBe(secret);
	});

	it("rejects an invalid phrase (bad checksum)", () => {
		expect(() => secretFromMnemonic("abandon abandon abandon")).toThrow();
	});
});
