const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * One HTTP client per provider: every request gets a hard time limit (also while connecting, which the
 * axios `timeout` alone does not cover) and a response size cap. Providers take `options.http` instead,
 * which is how the tests feed them recorded responses.
 */
function createHttp({ timeoutMs = 10000, headers = {} } = {}) {
  const http = axios.create({
    timeout: timeoutMs,
    maxRedirects: 5,
    maxContentLength: 8 * 1024 * 1024,
    headers: { 'User-Agent': USER_AGENT, ...headers },
  });
  http.interceptors.request.use((cfg) => {
    if (!cfg.signal) cfg.signal = AbortSignal.timeout(cfg.timeout || timeoutMs);
    return cfg;
  });
  return http;
}

/** HTTP status of a failed request, if the upstream answered at all. */
function statusOf(err) {
  return (err && err.response && err.response.status) || null;
}

/** Runs `fn` over `items`, at most `limit` at a time; a failing item becomes `null`. */
async function mapWithConcurrency(items, fn, limit = 5) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

module.exports = { createHttp, statusOf, mapWithConcurrency, USER_AGENT };
