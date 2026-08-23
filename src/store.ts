import { type Collection, MongoClient } from "mongodb";

/**
 * The index lives in the shared Mongo, in the same `paid-endpoints` rows the
 * daily probe has always written — the rows carry history (first seen, last
 * proved, failure streak), and history is the product. Written with the raw
 * driver so this repo needs a connection string and nothing else.
 */
export const COLLECTION = "paid-endpoints";

export type Accept = {
	network?: string | null;
	asset?: string | null;
	amount?: string | null;
	scheme?: string | null;
};

/** One indexed endpoint — the field names the rows already have. */
export type EndpointRow = {
	url: string;
	host: string | null;
	title: string | null;
	description: string | null;
	protocol: "x402" | "mpp" | "x402+mpp" | "unknown";
	acceptsStellar: boolean;
	accepts: Accept[];
	priceUSD: number | null;
	source:
		| "bazaar"
		| "mpp-router"
		| "stellar-directory"
		| "curated"
		| "openapi-discovery";
	sourceUrl: string | null;
	lastStatus: string;
	lastCheckedAt: Date;
	/** last time a real 402 challenge was read — not a payment */
	lastPaidAt?: Date | null;
	consecutiveFailures: number;
	note?: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export async function open(): Promise<{
	col: Collection<EndpointRow>;
	close: () => Promise<void>;
}> {
	const uri = process.env.DATABASE_URI?.trim();
	if (!uri)
		throw new Error(
			"DATABASE_URI is not set — copy .env.example to .env and fill it in.",
		);
	const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20_000 });
	await client.connect();
	const col = client.db().collection<EndpointRow>(COLLECTION);
	await col.createIndex({ url: 1 }, { unique: true });
	await col.createIndex({ acceptsStellar: 1, lastStatus: 1 });
	return { col, close: () => client.close() };
}
