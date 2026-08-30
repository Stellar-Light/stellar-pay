/**
 * The MARKETPLACE e2e — the thesis as one runnable story.
 *
 * A person pays an agent they've never met to complete real work, with no
 * platform and no trust: buyer and worker run as SEPARATE PROCESSES with
 * separate keys and separate ledgers, meeting only over a feed URL and the
 * chain.
 *
 *   buyer    posts an open bounty (escrow funded BEFORE a winner exists)
 *            and serves a feed + a submission inbox
 *   feed     also carries a DECOY: the same escrow with a tampered
 *            descriptor claiming 10x the payout — the worker must refuse it
 *   worker   (spawned, knows ONLY the feed URL) vets against the chain,
 *            does real verification work, submits a signed packet
 *   resolver settles: first valid evidence wins via the dispute path
 *   proof    worker exits having been PAID pot − 0.3%, its own ledger
 *            carries bounty-work-submit + bounty-income (with the tx);
 *            the buyer's ledger records the resolution and winner
 *
 *   npm run test:marketplace
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";

const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-mkt-buyer-"));
const WORKER_DIR = mkdtempSync(join(tmpdir(), "stellar-pay-mkt-worker-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
const PORT = Number(process.env.MARKETPLACE_PORT ?? 8897);
const AMOUNT = 10_000_000n; // 1 XLM pot
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const ITEMS = ["usdt0", "stellarsight"];

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function main() {
	console.log(
		"═══ marketplace e2e — a stranger agent finds, vets, works, and gets paid ═══\n",
	);
	const { postBounty, postOpenBounty, resolveOpenBounty } = await import(
		"../pay/bounty.js"
	);
	type OpenSubmission = import("../pay/bounty.js").OpenSubmission;

	const buyer = Keypair.random();
	const resolver = Keypair.random();
	await Promise.all([buyer, resolver].map((k) => friendbot(k.publicKey())));
	console.log(
		`buyer ${buyer.publicKey().slice(0, 8)} · resolver ${resolver.publicKey().slice(0, 8)}`,
	);

	// 1. Post the open bounty — money escrowed before any worker exists.
	const descriptor = postBounty({
		buyer: buyer.publicKey(),
		resolver: resolver.publicKey(),
		title: "verify 2 directory rows",
		items: ITEMS,
		instructions:
			"Fetch each live directory row; report existence, status, and an excerpt.",
		amount: AMOUNT,
		tokenContract: XLM_SAC,
		submitUrl: `http://127.0.0.1:${PORT}/submit`,
	});
	const posted = await postOpenBounty({ descriptor, buyer });
	console.log(
		`post     escrowed ${AMOUNT} at ${posted.contractId.slice(0, 10)}… — no winner exists yet`,
	);

	// 2. The feed — with a DECOY first: same escrow, descriptor claims 10x.
	// A worker that trusts the feed would be working for a lie.
	const decoy = { ...descriptor, amount: (AMOUNT * 10n).toString() };
	const feed = {
		bounties: [
			{ contractId: posted.contractId, descriptor: decoy },
			{ contractId: posted.contractId, descriptor },
		],
	};
	const packets: OpenSubmission[] = [];
	const server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/feed") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(feed));
			return;
		}
		if (req.method === "POST" && req.url === "/submit") {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				try {
					packets.push(JSON.parse(body) as OpenSubmission);
					res.statusCode = 200;
					res.end('{"ok":true}');
				} catch {
					res.statusCode = 400;
					res.end('{"ok":false}');
				}
			});
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

	// 3. The worker: a separate process, separate key, separate ledger — it
	// receives ONLY the feed URL.
	const events: Array<Record<string, unknown>> = [];
	const worker = spawn("npx", ["tsx", "src/sandbox/marketplace-worker.ts"], {
		env: {
			...process.env,
			FEED_URL: `http://127.0.0.1:${PORT}/feed`,
			STELLAR_PAY_SESSION_DIR: WORKER_DIR,
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	worker.stdout.setEncoding("utf8");
	let buf = "";
	worker.stdout.on("data", (chunk: string) => {
		buf += chunk;
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line.startsWith("{")) {
				const e = JSON.parse(line) as Record<string, unknown>;
				events.push(e);
				console.log(`worker   ${line}`);
			}
			nl = buf.indexOf("\n");
		}
	});
	const workerExit = new Promise<number>((r) =>
		worker.on("exit", (code) => r(code ?? 1)),
	);

	// 4. Operator loop: wait for a packet, then settle.
	const deadline = Date.now() + 180_000;
	while (packets.length === 0 && Date.now() < deadline)
		await new Promise((r) => setTimeout(r, 1000));
	if (packets.length === 0) throw new Error("no submission arrived");
	console.log(`inbox    ${packets.length} signed packet(s) received`);

	const res = await resolveOpenBounty({
		descriptor,
		resolver,
		contractId: posted.contractId,
		submissions: packets,
		disputeRaiser: buyer,
	});
	console.log(
		`settle   winner ${res.winner?.slice(0, 8)} via ${res.txs.length} txs`,
	);

	// 5. The worker's own verdict — did IT confirm being paid?
	const code = await workerExit;
	server.close();
	if (code !== 0) throw new Error(`worker exited ${code} — not paid`);

	const identity = events.find((e) => e.evt === "identity")?.worker as string;
	const vetted = events.find((e) => e.evt === "vetted")?.judged as Array<{
		valid: boolean;
		failed: string[];
	}>;
	const paid = events.find((e) => e.evt === "paid") as
		| { amountStroops: string; tx: string | null }
		| undefined;
	if (!identity || !vetted || !paid) throw new Error("worker events missing");

	// The decoy MUST have been refused, the honest row accepted.
	if (vetted.length !== 2 || vetted[0]?.valid || !vetted[1]?.valid)
		throw new Error("vet verdicts wrong — decoy accepted or honest refused");
	console.log(
		`vet      decoy REFUSED (${vetted[0]?.failed.join(", ")}) · honest row VALID`,
	);

	if (res.winner !== identity) throw new Error("winner is not the worker");
	const expected = AMOUNT - (AMOUNT * 30n) / 10_000n;
	if (BigInt(paid.amountStroops) !== expected)
		throw new Error(
			`worker credited ${paid.amountStroops}, expected ${expected}`,
		);
	console.log(
		`paid     worker credited ${paid.amountStroops} stroops (pot − 0.3%): EXACT ✓ (tx ${String(paid.tx).slice(0, 10)}…)`,
	);

	// 6. Both ledgers tell their half of the story.
	const workerRows = readFileSync(join(WORKER_DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { kind: string; tx?: string });
	const buyerRows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(
			(l) => JSON.parse(l) as { kind: string; detail?: { winner?: string } },
		);
	const income = workerRows.find((r) => r.kind === "bounty-income");
	if (!workerRows.some((r) => r.kind === "bounty-work-submit") || !income?.tx)
		throw new Error("worker ledger incomplete");
	if (
		!buyerRows.some(
			(r) => r.kind === "job-resolved" && r.detail?.winner === identity,
		)
	)
		throw new Error("buyer ledger missing the resolution");
	console.log(
		"ledger   worker: bounty-work-submit + bounty-income (with tx) · buyer: job-resolved names the winner",
	);

	console.log(
		"\nRESULT: PASS — a stranger agent discovered the task from a feed, refused the tampered listing, verified the honest one against the chain, did real work, and was paid the exact pot by the escrow. Two processes, two keys, two ledgers — no platform.",
	);
}

main().catch((err) => {
	console.error("FATAL:", err?.message ?? err);
	process.exit(1);
});
