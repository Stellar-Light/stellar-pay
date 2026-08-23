import { type Collection, MongoClient } from "mongodb";
import type { EndpointDoc } from "./types.js";

/**
 * The index is stored in the shared Mongo, not a committed file.
 *
 * The rows carry HISTORY — firstSeen, lastPaid, consecutiveMisses — and that
 * history is the product: "this endpoint has answered every day for three
 * months" and "this one went dark on the 4th" are the two things a caller
 * actually wants, and both are destroyed by regenerating a snapshot.
 *
 * Written with the raw driver rather than through Payload so this repo stays
 * standalone: it needs a connection string, nothing else.
 */
export const COLLECTION = "paid_endpoints";

export async function open(): Promise<{
	col: Collection<EndpointDoc>;
	close: () => Promise<void>;
}> {
	const uri = process.env.DATABASE_URI?.trim();
	if (!uri)
		throw new Error(
			"DATABASE_URI is not set — copy .env.example to .env and fill it in.",
		);
	const client = new MongoClient(uri);
	await client.connect();
	const col = client.db().collection<EndpointDoc>(COLLECTION);
	// url is the natural key; the unique index is what makes the writer an
	// idempotent upsert rather than an appender.
	await col.createIndex({ url: 1 }, { unique: true });
	await col.createIndex({ acceptsStellar: 1, outcome: 1 });
	return { col, close: () => client.close() };
}
