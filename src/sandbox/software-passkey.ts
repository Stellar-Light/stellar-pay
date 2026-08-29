/**
 * A SOFTWARE passkey — the headless authenticator that unlocks vault deploys.
 *
 * smart-account-kit's wallet creation is WebAuthn-shaped, but its config
 * accepts a custom `webAuthn` implementation. This is that implementation:
 * a P-256 keypair in process memory playing the role of the platform
 * authenticator. Registration hands the kit the RAW 65-byte uncompressed
 * public key via `response.publicKey` (the kit's extraction path #1 — no
 * CBOR attestation parsing involved); authentication signs
 * authenticatorData ‖ sha256(clientDataJSON) with ECDSA-SHA256 and returns
 * standard DER — the kit converts to compact low-S for the on-chain
 * verifier itself (`compactSignature`).
 *
 * SECURITY SHAPE, said plainly: this trades the platform authenticator's
 * hardware protection for headlessness. The key lives in process memory,
 * exactly like the ed25519 agent keys the kit's externalSigners manage. For
 * the VAULT design that is the point — the vault's safety comes from the
 * ON-CHAIN policy (caps, allowlists), not from where the signing key sleeps:
 * a compromised agent key still cannot exceed the cap. Testnet harness
 * today; the same trade is what makes agent custody workable at all.
 */
import {
	createHash,
	createSign,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64url");

type CreationOptions = {
	optionsJSON: {
		challenge: string;
		rp?: { id?: string; name?: string };
		user?: { id?: string; name?: string };
	};
};
type RequestOptions = {
	optionsJSON: {
		challenge: string;
		rpId?: string;
	};
};

export function softwarePasskey(rpIdDefault = "stellar-pay.local") {
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	// Raw uncompressed point (0x04 ‖ x ‖ y) — the kit's preferred wire shape.
	const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
	const rawPub = Buffer.concat([
		Buffer.from([0x04]),
		Buffer.from(jwk.x, "base64url"),
		Buffer.from(jwk.y, "base64url"),
	]);
	const credentialId = randomBytes(16);
	let counter = 0;

	const clientData = (type: string, challenge: string, rpId: string) =>
		Buffer.from(
			JSON.stringify({
				type,
				challenge,
				origin: `https://${rpId}`,
				crossOrigin: false,
			}),
		);

	const authData = (rpId: string, flags: number) => {
		const rpIdHash = createHash("sha256").update(rpId).digest();
		const count = Buffer.alloc(4);
		count.writeUInt32BE(++counter);
		return Buffer.concat([rpIdHash, Buffer.from([flags]), count]);
	};

	return {
		credentialId: b64url(credentialId),
		publicKeyRaw: rawPub,

		async startRegistration({ optionsJSON }: CreationOptions) {
			const rpId = optionsJSON.rp?.id ?? rpIdDefault;
			return {
				id: b64url(credentialId),
				rawId: b64url(credentialId),
				type: "public-key" as const,
				authenticatorAttachment: "platform" as const,
				clientExtensionResults: {},
				response: {
					clientDataJSON: b64url(
						clientData("webauthn.create", optionsJSON.challenge, rpId),
					),
					// The kit reads the key from `publicKey` (path #1); the
					// attestation object is format "none" filler, never parsed.
					attestationObject: b64url(Buffer.from([0xa0])),
					publicKey: b64url(rawPub),
					publicKeyAlgorithm: -7,
					transports: ["internal" as const],
				},
			};
		},

		async startAuthentication({ optionsJSON }: RequestOptions) {
			const rpId = optionsJSON.rpId ?? rpIdDefault;
			const cd = clientData("webauthn.get", optionsJSON.challenge, rpId);
			const ad = authData(rpId, 0x05); // UP | UV
			const signer = createSign("SHA256");
			signer.update(
				Buffer.concat([ad, createHash("sha256").update(cd).digest()]),
			);
			const signature = signer.sign(privateKey); // DER; kit compacts + low-S
			return {
				id: b64url(credentialId),
				rawId: b64url(credentialId),
				type: "public-key" as const,
				clientExtensionResults: {},
				response: {
					clientDataJSON: b64url(cd),
					authenticatorData: b64url(ad),
					signature: b64url(signature),
					userHandle: null,
				},
			};
		},
	};
}
