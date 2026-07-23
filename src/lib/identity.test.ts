import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	base64urlToBytes,
	bytesToBase64url,
	randomToken,
	sha256Base64url,
} from "./crypto.ts";
import {
	clearCredentials,
	generateSecret,
	getBearer,
	hasIdentity,
	hasRootSecret,
	mnemonicForSecret,
	secretFromMnemonic,
	storeDeviceToken,
	storeSecret,
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

describe("device credentials", () => {
	// The unit env is plain Node; back the storage helpers with a Map so the
	// root-secret / device-token precedence is exercisable without a DOM.
	beforeEach(() => {
		const store = new Map<string, string>();
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
		};
	});
	afterEach(() => {
		(globalThis as { localStorage?: unknown }).localStorage = undefined;
	});

	it("has no identity on a fresh device", () => {
		expect(hasIdentity()).toBe(false);
		expect(getBearer()).toBeNull();
	});

	it("uses the root secret as the bearer when no token is present", () => {
		const { secret } = generateSecret();
		storeSecret(secret);
		expect(getBearer()).toBe(secret);
		expect(hasIdentity()).toBe(true);
		expect(hasRootSecret()).toBe(true);
	});

	it("a token-only device authenticates but holds no phrase", () => {
		const token = randomToken();
		storeDeviceToken(token);
		expect(getBearer()).toBe(token);
		expect(hasIdentity()).toBe(true);
		expect(hasRootSecret()).toBe(false);
	});

	it("prefers the device token over the root secret", () => {
		const { secret } = generateSecret();
		const token = randomToken();
		storeSecret(secret);
		storeDeviceToken(token);
		expect(getBearer()).toBe(token);
	});

	it("clears both the secret and the token", () => {
		storeSecret(generateSecret().secret);
		storeDeviceToken(randomToken());
		clearCredentials();
		expect(getBearer()).toBeNull();
		expect(hasIdentity()).toBe(false);
		expect(hasRootSecret()).toBe(false);
	});
});
