/**
 * send_usdc is the highest-risk agent action in the codebase — a direct
 * transfer to an arbitrary address, i.e. the exfiltration path — and the audit
 * found it had NO test at all. These exercise the MCP tool's guards over
 * stdio, on testnet, without ever completing a transfer to a stranger.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@stellar/stellar-sdk";

let pass = 0,
	fail = 0;
const check = (n: string, c: boolean, d = "") => {
	if (c) {
		pass++;
		console.log(`  ✓ ${n}`);
	} else {
		fail++;
		console.log(`  ✗ ${n}  ${d}`);
	}
};
const text = (r: unknown) =>
	((r as { content?: Array<{ text?: string }> }).content?.[0]?.text ??
		"") as string;

// A funded testnet wallet the server will load. Nothing here reaches mainnet.
const kp = Keypair.random();
await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`).catch(
	() => {},
);

const client = new Client({ name: "send-test", version: "0" });
await client.connect(
	new StdioClientTransport({
		command: process.execPath,
		args: ["--import", "tsx", "src/cli.ts", "mcp"],
		env: {
			...process.env,
			STELLAR_SECRET_KEY: kp.secret(),
			STELLAR_NETWORK: "stellar:testnet",
			STELLAR_PAY_MAX_USD_PER_CALL: "0.05",
		},
	}),
);

const call = async (args: Record<string, unknown>) =>
	text(await client.callTool({ name: "send_usdc", arguments: args }));

const STRANGER = Keypair.random().publicKey();

// 1. A malformed address must never reach the network.
check(
	"a non-Stellar address is rejected",
	/not a Stellar account/i.test(
		await call({ to: "not-an-address", amount: "1" }),
	),
);

// 2. Amount validation.
check(
	"a non-positive amount is rejected",
	/positive/i.test(await call({ to: STRANGER, amount: "0" })),
);
check(
	"a negative amount is rejected",
	/positive/i.test(await call({ to: STRANGER, amount: "-5" })),
);

// 3. THE CORE GUARD: one call must never move funds. It previews and returns a
//    token; nothing is signed.
const preview = await call({ to: STRANGER, amount: "0.01" });
check(
	"a single call only PREVIEWS — nothing moves",
	/confirm_token/.test(preview) && !/"sent"/.test(preview),
	preview.slice(0, 120),
);
const token = (JSON.parse(preview) as { confirm_token?: string }).confirm_token;
check("the preview issues a server-generated token", typeof token === "string");

// 4. The token must not be forgeable from the arguments the agent already has.
check(
	"a guessed/forged token is refused",
	/invalid, expired, or already-used/i.test(
		await call({
			to: STRANGER,
			amount: "0.01",
			confirm: `send:stellar:testnet:${STRANGER}:0.01`,
		}),
	),
);

// 5. A token must not be reusable for DIFFERENT terms than it was issued for.
check(
	"a token issued for one amount cannot authorise another",
	/invalid, expired, or already-used/i.test(
		await call({ to: STRANGER, amount: "0.02", confirm: token ?? "x" }),
	),
);

// 6. …and that failed attempt must have consumed it (single use).
check(
	"a token is single-use even after a failed attempt",
	/invalid, expired, or already-used/i.test(
		await call({ to: STRANGER, amount: "0.01", confirm: token ?? "x" }),
	),
);

await client.close();
console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} send_usdc guard checks`,
);
process.exit(fail === 0 ? 0 : 1);
