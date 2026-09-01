import { resolveHost } from "./policy.js";

/**
 * SSRF target guard — SHARED, side-effect-free.
 *
 * Extracted from mcp.ts 2026-09-01 (Grok audit finding 6, still open from
 * META-AUDIT F7): the MCP door ran this guard on every URL and every redirect
 * hop while CLI `curl` and `run` ran only the spend policy, which has no
 * concept of an IP literal. A 302 to 169.254.169.254 or 127.0.0.1 walked
 * straight through the two doors a human is most likely to use. Guards belong
 * in a library both doors import, never in one door's module.
 */

/**
 * SSRF guard for the agent-driven `curl` tool: a prompt-injected agent must not
 * be able to reach the loopback/private/link-local network (cloud metadata at
 * 169.254.169.254, internal services) or a non-http(s) scheme. Returns a reason
 * string when the target is blocked, or null when it's allowed. The sandbox and
 * local dev opt in with STELLAR_PAY_ALLOW_PRIVATE=1.
 */
export function privateIp(h: string): boolean {
	// IPv4-mapped IPv6: Node's URL canonicalizes to the HEX form
	// ([::ffff:127.0.0.1] → ::ffff:7f00:1); unwrap either form and re-check
	// the embedded IPv4.
	const mapped =
		/^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/.exec(h);
	if (mapped) {
		if (mapped[3]) return privateIp(mapped[3]);
		const hi = Number.parseInt(mapped[1] as string, 16);
		const lo = Number.parseInt(mapped[2] as string, 16);
		return privateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	return (
		h === "localhost" ||
		h === "::1" ||
		h === "::" ||
		h === "0.0.0.0" ||
		/^127\./.test(h) ||
		/^0\./.test(h) ||
		/^10\./.test(h) ||
		/^192\.168\./.test(h) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
		/^169\.254\./.test(h) || // link-local incl. cloud metadata
		/^(fe80:|fc|fd)/.test(h) ||
		h.endsWith(".local") ||
		h.endsWith(".internal")
	);
}

export async function blockedTarget(raw: string): Promise<string | null> {
	if (process.env.STELLAR_PAY_ALLOW_PRIVATE === "1") return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return `"${raw}" is not a valid URL`;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:")
		return `refused: ${u.protocol} is not an http(s) URL`;
	const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (privateIp(h))
		return `refused: ${h} is a loopback/private/link-local address — the paid catalog is public hosts only`;
	// A public NAME can still resolve to a private address (DNS rebinding).
	// Resolve and re-check every address; an unresolvable host is left for the
	// fetch itself to fail. The check-then-fetch gap is not fully closable
	// without socket pinning, but this removes the plain rebinding path.
	if (!/^[\d.]+$/.test(h) && !h.includes(":")) {
		try {
			const { lookup } = await import("node:dns/promises");
			const addrs = await lookup(h, { all: true, verbatim: true });
			for (const a of addrs)
				if (privateIp(a.address.toLowerCase()))
					return `refused: ${h} resolves to ${a.address}, a loopback/private/link-local address`;
		} catch {
			// unresolvable — let fetch report it
		}
	}
	return null;
}

/**
 * The FULL target gate every paying door must run: SSRF ∪ per-host spend
 * policy. Both halves or neither — the 2026-09-01 audit found the MCP door
 * running the union inline while the two CLI doors ran only the policy half,
 * because the union was three lines of prose repeated per door instead of one
 * named thing. A door that forgets to compose it cannot exist now: there is
 * one function, and forgetting it is a missing call, not a subtly weaker gate.
 */
export async function payGuard(
	url: string,
	o: { requested: number; requestedExplicit?: boolean },
): Promise<string | null> {
	return (await blockedTarget(url)) ?? resolveHost(url, o).blocked ?? null;
}
