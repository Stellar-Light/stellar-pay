/**
 * Response handling: buffering, replay, and consumption instrumentation.
 */

export const SUPPRESSION_HEADER = 'x-scrimp-suppressed';

// Statuses the Fetch spec forbids a body on; `new Response(body, { status })`
// throws for these unless the body is null.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const BODY_METHODS = ['json', 'text', 'arrayBuffer', 'blob', 'bytes', 'formData'];

/**
 * Drain a payer's Response into a plain, replayable record.
 *
 * A Response body is a one-shot stream, but the `duplicate` and `fresh` rules
 * have to hand the same bytes back later — possibly several times. So the body
 * is read exactly once here, at purchase time, and every Response the caller
 * ever sees (including the first) is rebuilt from this buffer.
 */
export async function bufferResponse(response) {
  const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
    body,
  };
}

/** Build a fresh, independently-readable Response from a buffered entry. */
export function responseFromEntry(entry, extraHeaders = {}) {
  const headers = new Headers(entry.headers);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  // slice() so each replay owns its own bytes and cannot detach the buffer.
  const body = entry.body === null || entry.body === undefined ? null : entry.body.slice(0);
  return new Response(body, { status: entry.status, statusText: entry.statusText, headers });
}

/** The Response returned when a rule refuses to purchase at all. */
export function suppressedResponse(reason, { status = 402, payload } = {}) {
  const body = JSON.stringify(payload ?? { error: 'suppressed_by_scrimp', reason });
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      [SUPPRESSION_HEADER]: reason,
    },
  });
}

/**
 * AC-E2-3. Consumption tracking without agent cooperation.
 *
 * The agent never tells us whether it used what it bought, so we watch the only
 * observable that matters: did anything read the body? Each body-reading method
 * is shadowed by an own-property on this Response instance that reports the read
 * and then delegates to the original prototype method.
 *
 * Own properties (rather than a Proxy or a subclass) keep normal Response
 * semantics intact: the object still passes `instanceof Response`, internal
 * slots like `status`, `headers`, `ok` and `bodyUsed` are untouched, and a
 * second read still throws the usual "body already used" TypeError.
 *
 * `onRead` fires when the read is *requested*, not when it resolves — a caller
 * that asks for the bytes has consumed the purchase even if the JSON turns out
 * to be malformed. It must be idempotent.
 */
export function instrumentResponse(response, onRead) {
  for (const name of BODY_METHODS) {
    const original = response[name];
    if (typeof original !== 'function') continue;
    define(response, name, function instrumented(...args) {
      onRead();
      return original.apply(this, args);
    });
  }

  const clone = response.clone;
  if (typeof clone === 'function') {
    define(response, 'clone', function instrumentedClone() {
      return instrumentResponse(clone.call(this), onRead);
    });
  }

  return response;
}

function define(target, name, value) {
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}
