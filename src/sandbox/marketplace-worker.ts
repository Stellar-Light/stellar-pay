/**
 * The reference WORKER agent — a standalone process that earns.
 *
 * It is given exactly ONE thing: a feed URL (env FEED_URL). It shares no
 * memory, no keys, and no code path with the buyer who posted the work —
 * they meet only over the descriptor and the chain. The loop:
 *
 *   discover  fetch the feed
 *   vet       check every listing against the CHAIN (refuse tampered or
 *             unfunded rows — the feed is a claim, not a truth)
 *   work      actually DO the verification (live directory fetches)
 *   submit    sign the evidence to OUR payout address, POST the packet
 *   collect   watch the escrow settle; confirm the credit landed HERE
 *
 * Emits JSON-line events on stdout so the harness (or a human) can follow.
 * Exit codes: 0 paid · 5 lost the race / refunded · 6 nothing workable.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { type EvidenceEntry, makeCommit } from "../pay/bounty.js";
import {
	awaitPayout,
	fetchFeed,
	submitPacket,
	vetListing,
} from "../pay/worker.js";

const FEED_URL = process.env.FEED_URL ?? "";
const evt = (e: Record<string, unknown>) => console.log(JSON.stringify(e));

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

/** The actual work: verify each directory row against the live site. */
async function doTheWork(items: string[]): Promise<EvidenceEntry[]> {
	const out: EvidenceEntry[] = [];
	for (const slug of items) {
		const url = `https://stellarlight.xyz/api/projects?where%5Bslug%5D%5Bequals%5D=${slug}&limit=1&depth=0`;
		const r = await fetch(url);
		const d = (await r.json()) as {
			docs?: Array<{ status?: string; shortDescription?: string }>;
		};
		const row = d.docs?.[0];
		out.push({
			item: slug,
			url,
			verdict: row ? `row present, status=${row.status}` : "row MISSING",
			checkedAt: new Date().toISOString(),
			excerpt: (row?.shortDescription ?? "(none)").slice(0, 140),
		});
	}
	return out;
}

async function main() {
	if (!FEED_URL) throw new Error("FEED_URL not set");
	const me = Keypair.random();
	await friendbot(me.publicKey());
	evt({ evt: "identity", worker: me.publicKey() });

	// discover + vet — the feed is untrusted input.
	const listings = await fetchFeed(FEED_URL);
	const judged: Array<{
		contractId: string;
		claimedAmount: string | undefined;
		valid: boolean;
		failed: string[];
	}> = [];
	for (const listing of listings) {
		const vet = await vetListing({ listing, source: me });
		judged.push({
			contractId: listing.contractId,
			claimedAmount: listing.descriptor?.amount,
			valid: vet.ok,
			failed: vet.checks.filter((c) => !c.ok).map((c) => c.name),
		});
	}
	evt({ evt: "vetted", judged });
	const pick = listings.find((_, i) => judged[i]?.valid);
	if (!pick) {
		evt({ evt: "done", outcome: "nothing-workable" });
		process.exit(6);
	}
	const d = pick.descriptor;
	if (!d.submitUrl) throw new Error("workable listing has no submitUrl");

	// work — for real.
	const evidence = await doTheWork(d.items);
	evt({ evt: "worked", items: evidence.map((e) => e.item) });

	// COMMIT, then reveal (audit finding 2c). This reference worker — the one
	// `test:marketplace` runs as "the thesis end to end" — used to skip the
	// commit entirely and POST its evidence straight to the inbox, which is
	// how the demo path ran the fastest-reveal race the README said it had
	// replaced. The commit goes out BEFORE the evidence, so a thief who only
	// sees the evidence at reveal time has nothing to open.
	const { commit, nonce } = makeCommit({
		worker: me,
		contractId: pick.contractId,
		evidence,
	});
	await fetch(d.submitUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(commit),
	}).catch(() => undefined);
	evt({ evt: "committed", commitHash: commit.commitHash.slice(0, 12) });

	// reveal — the signature binds this evidence to OUR payout address, and the
	// nonce opens the commit above.
	const sub = await submitPacket({
		worker: me,
		contractId: pick.contractId,
		evidence,
		url: d.submitUrl,
		nonce,
	});
	evt({ evt: "submitted", status: sub.status });

	// collect — did the chain pay US?
	const payout = await awaitPayout({
		contractId: pick.contractId,
		worker: me,
		timeoutMs: 240_000,
	});
	if (payout.paid) {
		evt({
			evt: "paid",
			amountStroops: payout.amountStroops.toString(),
			tx: payout.tx,
			receiptId: payout.receiptId,
		});
		process.exit(0);
	}
	evt({ evt: "done", outcome: payout.reason });
	process.exit(payout.reason === "lost-or-refunded" ? 5 : 6);
}

main().catch((err) => {
	evt({ evt: "fatal", error: err?.message ?? String(err) });
	process.exit(1);
});
