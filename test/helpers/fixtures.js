const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));

/**
 * Stands in for a provider's HTTP client: `routes` is a list of [pattern, body]; the first pattern found in
 * the requested address answers. Every request is recorded in `calls`.
 */
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, params: options.params });
      for (const [pattern, body] of routes) {
        if (url.includes(pattern)) {
          if (body instanceof Error) throw body;
          return { status: 200, data: typeof body === 'function' ? body(url, options) : body };
        }
      }
      throw new Error(`no fixture for ${url}`);
    },
  };
}

const silentLog = { log() {}, error() {}, warn() {} };

module.exports = { fixture, jsonFixture, fakeHttp, silentLog };
