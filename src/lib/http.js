const https = require('https');
const tls = require('tls');
const axios = require('axios');

let bundledAgent = null;
function bundledCaAgent() {
  if (!bundledAgent) bundledAgent = new https.Agent({ ca: tls.rootCertificates, keepAlive: true });
  return bundledAgent;
}

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
  // With the operating system's certificates added (NODE_USE_SYSTEM_CA=1, --use-system-ca), a cross-signed
  // copy of a root in the macOS keychain makes OpenSSL 3.x build a chain it cannot finish (seen with Certum,
  // which signs audioteka.com, on Node 24). The chain is fine against Node's own root list: try once with that.
  http.interceptors.response.use(undefined, (error) => {
    const cfg = error && error.config;
    if (!cfg || cfg._bundledCaRetry || error.code !== 'UNABLE_TO_GET_ISSUER_CERT') throw error;
    cfg._bundledCaRetry = true;
    cfg.httpsAgent = bundledCaAgent();
    cfg.signal = AbortSignal.timeout(cfg.timeout || timeoutMs);
    return http.request(cfg);
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
