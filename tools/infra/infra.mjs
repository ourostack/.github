// GitHub's own transient failures are infrastructure, not a red the code caused. A tool that still sees one
// after a single retry exits with `::error title=infra::`, which red-main counts apart from code red and
// auto-revert never reverts (tools/red-main/README.md).

export const TRANSIENT_TEXT =
  /Something went wrong while executing your query|secondary rate limit|abuse detection|\bHTTP 50[234]\b|\b50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i;
export const RETRY_PAUSE_MS = 5000;

export class InfraError extends Error {
  constructor(message, requestId) {
    super(message);
    this.name = "InfraError";
    this.requestId = requestId;
  }
}

// A GitHub failure worth one retry: 502/503/504, a secondary rate limit, or the GraphQL "Something went wrong" error.
export function isTransient(status, payload) {
  if (status === 502 || status === 503 || status === 504) return true;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  return TRANSIENT_TEXT.test(text);
}

// The id GitHub asks for in a report: the response header, else the `E840:...` id inside the GraphQL message.
export function requestIdOf(res, payload) {
  const header = res?.headers?.get?.("x-github-request-id");
  if (header) return header;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  return /\b([0-9A-F]{4}:[0-9A-F:]{6,})\b/.exec(text)?.[1] ?? "unknown";
}

// Run one GitHub call (returning { res, payload }) with a single retry on a transient failure. A second transient
// failure throws InfraError; anything else is returned for the caller to judge.
export async function callWithInfraRetry(call, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pause = RETRY_PAUSE_MS } = {}) {
  let out = await call();
  if (!isTransient(out.res?.status, out.payload)) return out;
  await sleep(pause);
  out = await call();
  if (!isTransient(out.res?.status, out.payload)) return out;
  const detail = JSON.stringify(out.payload?.errors ?? out.payload?.message ?? out.payload ?? "").slice(0, 300);
  throw new InfraError(`GitHub transient failure (HTTP ${out.res?.status}) twice: ${detail}`, requestIdOf(out.res, out.payload));
}

// Print the annotation red-main reads and exit; use it in a tool's top-level catch.
export function exitInfra(err, { log = console.log, exit = process.exit } = {}) {
  log(`::error title=infra::${String(err.message).replace(/\r?\n/g, " ")} (GitHub request id ${err.requestId})`);
  exit(1);
}
