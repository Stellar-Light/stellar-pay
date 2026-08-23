// Minimal types for the vendored Scrimp core (kaankacar/scrimp @ 82b082c).
export interface ScrimpOptions {
	payer: (url: string, init?: RequestInit) => Promise<Response>;
	store?: unknown;
	rules?: unknown[];
	priceOf?: (url: string, init?: RequestInit) => number;
	txHashOf?: (response: Response, url: string, init?: RequestInit) => string | null;
	providerOf?: (url: string, init?: RequestInit) => string;
	endpointOf?: (url: string, init?: RequestInit) => string;
	now?: () => number;
}
export interface ScrimpReport {
	spent: number;
	wouldHaveSpent: number;
	saved: number;
	savedPct: number;
	purchases: number;
	suppressed: number;
	wasteRate: number;
}
export class ScrimpClient {
	constructor(options: ScrimpOptions);
	readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
	beginTask(taskId: string, opts?: { budget?: number | null }): unknown;
	endTask(taskId: string, opts?: { succeeded?: boolean }): { taskId: string; succeeded: boolean; contributed: number; wasted: number };
	report(options?: { taskId?: string }): ScrimpReport;
	purchases(): Array<Record<string, unknown>>;
	stats(): Array<Record<string, unknown>>;
	setRuleEnabled(name: string, enabled: boolean): unknown;
	get activeTask(): unknown;
}
export class MemoryStore {}
export class SessionStore {}
export const SUPPRESSION_HEADER: string;
