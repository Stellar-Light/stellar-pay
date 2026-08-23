/**
 * Request description: everything the rules and the receipts need to know about
 * a call, derived once per `fetch` so no rule has to re-parse a URL.
 */

/** Identity of a purchase for the `duplicate` and `fresh` rules: method + url + body. */
export function requestKey({ method, url, body }) {
  return `${method} ${url} ${body}`;
}

export function describeRequest(url, init = {}, naming = {}) {
  const href = hrefOf(url);
  const method = String(init.method ?? 'GET').toUpperCase();
  const body = normalizeBody(init.body);
  const parsed = parseUrl(href);

  const provider = naming.providerOf ? naming.providerOf(href, init) : (parsed ? parsed.host : href);
  const endpoint = naming.endpointOf ? naming.endpointOf(href, init) : (parsed ? parsed.pathname : href);

  const request = { url: href, method, body, provider, endpoint };
  request.key = requestKey(request);
  return request;
}

function hrefOf(url) {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  // Request-shaped input (`fetch` accepts one), or anything stringifiable.
  if (url && typeof url === 'object' && typeof url.url === 'string') return url.url;
  return String(url);
}

function parseUrl(href) {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** Bodies only ever feed the request key, so any stable string projection works. */
function normalizeBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('base64');
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64');
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}
