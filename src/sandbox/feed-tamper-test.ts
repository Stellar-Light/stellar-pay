/**
 * A hostile feed cannot retarget where evidence is delivered — audit finding 2.
 *
 * THE ATTACK. `submitUrl` used to live only on the feed row. It was not in the
 * JobSpec, so it was not in the agreement, so it was not in `engagement_id`,
 * so `checkListing` had nothing to compare it against. An attacker could copy
 * an honest, funded, correctly-escrowed bounty verbatim, change ONLY the
 * inbox, and republish it. Every check a careful worker runs — terms pinned,
 * struct matches, decision seats, pot funded — passes, because all of those
 * are true: it IS the real bounty. The worker does the work, POSTs the
 * evidence to the attacker, who re-signs it under a sock puppet and collects
 * the pot. Nothing on-chain ever looks wrong.
 *
 * `submitUrl` is now part of the hashed terms, so retargeting the inbox
 * changes the agreement hash and the worker's existing
 * `descriptor-matches-terms` check fails. No new check was needed — the
 * binding was the missing part.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { openBountyTerms, postBounty } from "../pay/bounty.js";

const buyer = Keypair.random().publicKey();
const resolver = Keypair.random().publicKey();
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const base = {
	buyer,
	resolver,
	title: "Verify three directory rows",
	items: ["row-a", "row-b", "row-c"],
	instructions: "Check each row is live and record an excerpt.",
	amount: 10_000_000n,
	tokenContract: TOKEN,
};

let ok = 0;
let bad = 0;
const check = (pass: boolean, label: string) => {
	console.log(`  ${pass ? "✓" : "✗"} ${label}`);
	pass ? ok++ : bad++;
};

const honest = postBounty({
	...base,
	submitUrl: "https://resolver.example/inbox",
});
const hijacked = postBounty({
	...base,
	submitUrl: "https://attacker.example/inbox",
});

const hHash = openBountyTerms(honest).hash;
const xHash = openBountyTerms(hijacked).hash;

check(
	hHash !== xHash,
	"swapping ONLY submitUrl changes the agreement hash (so it changes engagement_id)",
);
check(
	openBountyTerms(honest).doc.includes("https://resolver.example/inbox"),
	"the inbox is written into the agreement a human can read",
);

// The worker's vet compares re-derived terms against the escrow's pinned
// engagement_id. Simulate: the escrow was funded with the HONEST terms.
const pinnedOnChain = hHash;
check(
	openBountyTerms(honest).hash === pinnedOnChain,
	"honest listing still vets clean (no false positive on the real bounty)",
);
check(
	openBountyTerms(hijacked).hash !== pinnedOnChain,
	"the retargeted listing FAILS descriptor-matches-terms — the attack is caught",
);

// A bounty with no submitUrl at all (out-of-band transport) must still work
// and must not collide with one that has an empty-ish inbox.
const noInbox = postBounty(base);
check(
	openBountyTerms(noInbox).hash !== hHash,
	"a descriptor with no submitUrl is distinct from one that names an inbox",
);
check(
	!openBountyTerms(noInbox).doc.includes("POST to:"),
	"and it does not invent an inbox line it cannot honour",
);

console.log(
	`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`} — ${ok}/${ok + bad}`,
);
process.exit(bad === 0 ? 0 : 1);
