// A CDN edge (Cloudflare in front of GitHub Pages) sometimes answers one request of a large crawl with a transient 5xx,
// including a bare 500, and recovers within seconds. Retry those, and network errors, a few times with a growing wait.
export const RETRY_STATUSES = [429, 500, 502, 503, 504];

export async function fetchWithRetry(url, init = {}, { attempts = 4, wait = (n) => 1000 * n, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, init);
      const body = Buffer.from(await res.arrayBuffer());
      if (RETRY_STATUSES.includes(res.status) && attempt < attempts) {
        await sleep(wait(attempt));
        continue;
      }
      return { status: res.status, url: res.url, type: res.headers.get("content-type") ?? "", body };
    } catch (err) {
      if (attempt >= attempts) return { status: 0, url, type: "", body: Buffer.alloc(0), error: String(err.cause?.code ?? err.message) };
      await sleep(wait(attempt) / 2);
    }
  }
}
