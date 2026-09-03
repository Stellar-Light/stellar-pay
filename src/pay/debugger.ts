/**
 * The payment debugger — see what actually happened, locally.
 *
 * pay.sh ships a Payment Debugger and their own troubleshooting page
 * recommends it for two of five documented error conditions; ours had no
 * equivalent. A `test:*` suite is our own regression proof, not something a
 * user can point at a live 402 to ask "what did the seller send, what did we
 * sign, and why was that refused".
 *
 * Deliberately thin. The receipts ledger is ALREADY an append-only,
 * timestamped, chained record of every payment, refusal, session and job
 * event — most of what a timeline needs already exists. So this reads that
 * file and renders it; it does not instrument the payment path, add a proxy,
 * or introduce a dependency. Nothing here can change what a payment does.
 *
 * What it deliberately does NOT do, so the UI cannot imply more than the data
 * supports:
 *   - it never says "verified", only whether a row CARRIES what an on-chain
 *     check needs (`receipts --verify <id>` is what actually proves one);
 *   - it never renders an absent amount as 0 — absent is an em dash;
 *   - it shows refusals as prominently as payments, because "why did nothing
 *     happen" is the question a debugger exists to answer.
 *
 * Bind: loopback only. The ledger names counterparties, amounts and URLs; it
 * is not something to serve on 0.0.0.0 by default.
 */
import { createServer, type Server } from "node:http";
import { checkLedger, list, type ReceiptRow } from "./receipts.js";

/** One row, shaped for display. Absent stays absent. */
type Entry = {
	id: string;
	at: string;
	kind: string;
	protocol: string | null;
	url: string | null;
	amount: string | null;
	asset: string | null;
	payee: string | null;
	tx: string | null;
	refs: string[];
	/** the rule named by a policy-decision row (its own, or one it references) */
	rule: string | null;
	/** false for a refusal — the row says the spend did NOT happen */
	allowed: boolean | null;
	/** carries what an on-chain check needs; NOT a claim that one ran */
	checkable: boolean;
};

function toEntry(r: ReceiptRow, byId: Map<string, ReceiptRow>): Entry {
	const detail = (r.detail ?? {}) as Record<string, unknown>;
	let rule = typeof detail.rule === "string" ? detail.rule : null;
	if (!rule)
		for (const ref of r.refs ?? []) {
			const d = byId.get(ref);
			const dd = (d?.detail ?? {}) as Record<string, unknown>;
			if (d?.kind === "policy-decision" && typeof dd.rule === "string") {
				rule = dd.rule;
				break;
			}
		}
	return {
		id: r.id,
		at: r.at,
		kind: r.kind,
		protocol: r.protocol ?? null,
		url: r.url ?? null,
		amount: r.amount ?? null,
		asset: r.asset ?? null,
		payee: r.payee ?? null,
		tx: r.tx ?? null,
		refs: r.refs ?? [],
		rule,
		allowed: typeof detail.allowed === "boolean" ? detail.allowed : null,
		// Presence only — never a claim that a check RAN. (Once the muxed
		// settlement resolver lands on main, this should resolve the payee
		// the same way `statement()` does; a muxed row is otherwise shown as
		// checkable on a payee Horizon will not report verbatim.)
		checkable: Boolean(r.tx && r.amount && r.payee && r.network),
	};
}

export type DebuggerSnapshot = {
	entries: Entry[];
	/** tamper state, surfaced rather than assumed — a debugger reading a
	 *  doctored ledger should say so before anything else. */
	ledger: { ok: boolean; rows: number; edited: number; unlinked: number };
	generatedAt: string;
};

export function snapshot(limit = 500): DebuggerSnapshot {
	const rows = list({ limit });
	const byId = new Map(rows.map((r) => [r.id, r]));
	const integrity = checkLedger();
	return {
		entries: rows.map((r) => toEntry(r, byId)).reverse(), // newest first to read
		ledger: {
			ok: integrity.ok,
			rows: integrity.rows,
			edited: integrity.bad.length,
			unlinked: integrity.unlinked.length,
		},
		generatedAt: new Date().toISOString(),
	};
}

const PAGE = String.raw`<!doctype html><meta charset="utf-8">
<title>stellar-pay debugger</title>
<style>
 :root{--bg:#0f1115;--panel:#161922;--line:#242836;--ink:#e6e8ee;--dim:#8b93a7;--ok:#4ec9a5;--no:#e06a6a;--acc:#7aa2f7}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
 header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;flex-wrap:wrap}
 h1{font-size:14px;margin:0;font-weight:600;letter-spacing:.02em}
 .tag{font-size:11px;color:var(--dim)}
 input,select{background:var(--panel);border:1px solid var(--line);color:var(--ink);padding:5px 8px;border-radius:6px;font:inherit}
 main{padding:14px 18px;display:flex;flex-direction:column;gap:8px}
 .row{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:10px 12px}
 .row.refused{border-left-color:var(--no)} .row.paid{border-left-color:var(--ok)}
 .top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
 .kind{font-weight:600} .dim{color:var(--dim)} .amt{margin-left:auto;font-variant-numeric:tabular-nums}
 .url{color:var(--acc);word-break:break-all}
 .meta{margin-top:6px;color:var(--dim);font-size:12px;display:flex;gap:14px;flex-wrap:wrap}
 .banner{padding:10px 18px;background:#3a1d1d;border-bottom:1px solid var(--no);color:#ffd9d9}
 code{color:var(--ink)}
</style>
<header>
 <h1>stellar-pay debugger</h1>
 <span class="tag" id="count"></span>
 <input id="q" placeholder="filter: url, kind, tx, rule…" style="min-width:260px">
 <select id="kind"><option value="">every kind</option></select>
 <label class="tag"><input type="checkbox" id="only" style="vertical-align:-1px"> refusals only</label>
 <span class="tag" id="stamp" style="margin-left:auto"></span>
</header>
<div id="tamper"></div>
<main id="list"></main>
<script>
const el=(s)=>document.querySelector(s);
const esc=(s)=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const dash=(v)=>v===null||v===undefined||v===''?'<span class="dim">—</span>':esc(v);
let data={entries:[],ledger:{ok:true}};
function render(){
 const q=el('#q').value.toLowerCase(), k=el('#kind').value, only=el('#only').checked;
 const rows=data.entries.filter(e=>{
  if(k&&e.kind!==k) return false;
  if(only&&e.allowed!==false) return false;
  if(!q) return true;
  return [e.url,e.kind,e.tx,e.rule,e.payee,e.asset].filter(Boolean).join(' ').toLowerCase().includes(q);
 });
 el('#count').textContent=rows.length+' of '+data.entries.length+' rows';
 el('#list').innerHTML=rows.map(e=>{
  const cls=e.allowed===false?'refused':(e.tx?'paid':'');
  // An absent amount is an em dash. Never 0.
  const amt=e.amount?esc(e.amount)+' '+(e.asset?esc(e.asset):''):'<span class="dim">—</span>';
  return '<div class="row '+cls+'">'+
   '<div class="top"><span class="kind">'+esc(e.kind)+'</span>'+
   (e.protocol?'<span class="tag">'+esc(e.protocol)+'</span>':'')+
   '<span class="dim">'+esc(e.at.slice(0,19).replace('T',' '))+'</span>'+
   '<span class="amt">'+amt+'</span></div>'+
   (e.url?'<div class="url">'+esc(e.url)+'</div>':'')+
   '<div class="meta">'+
    '<span>id '+esc(e.id.slice(0,10))+'</span>'+
    (e.rule?'<span>rule: '+esc(e.rule)+'</span>':'')+
    '<span>tx '+dash(e.tx&&e.tx.slice(0,12))+'</span>'+
    '<span>payee '+dash(e.payee&&e.payee.slice(0,12))+'</span>'+
    '<span>'+(e.checkable?'carries what an on-chain check needs':'<span class="dim">not enough on the row to check on-chain</span>')+'</span>'+
   '</div></div>';
 }).join('')||'<div class="row dim">no rows match</div>';
}
async function poll(){
 try{
  const r=await fetch('/api/receipts'); data=await r.json();
  const sel=el('#kind'), cur=sel.value;
  const kinds=[...new Set(data.entries.map(e=>e.kind))].sort();
  sel.innerHTML='<option value="">every kind</option>'+kinds.map(k=>'<option>'+esc(k)+'</option>').join('');
  sel.value=cur;
  el('#stamp').textContent='updated '+new Date(data.generatedAt).toLocaleTimeString();
  el('#tamper').innerHTML=data.ledger.ok?'':
   '<div class="banner">ledger integrity FAILED — '+data.ledger.edited+' edited, '+
   data.ledger.unlinked+' unlinked. Rows below may not be what was written. Run <code>receipts check</code>.</div>';
  render();
 }catch(e){ el('#stamp').textContent='disconnected'; }
}
for(const id of ['#q','#kind','#only']) el(id).addEventListener('input',render);
poll(); setInterval(poll,2000);
</script>`;

/** Start the debugger on loopback. Returns the server and its URL. */
export async function startDebugger(
	port = 1402,
): Promise<{ server: Server; url: string }> {
	const server = createServer((req, res) => {
		if ((req.url ?? "/").startsWith("/api/receipts")) {
			res.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			res.end(JSON.stringify(snapshot()));
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(PAGE);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		// Loopback ONLY: the ledger names counterparties, amounts and URLs.
		server.listen(port, "127.0.0.1", () => resolve());
	});
	const addr = server.address();
	const bound = typeof addr === "object" && addr ? addr.port : port;
	return { server, url: `http://127.0.0.1:${bound}/` };
}
