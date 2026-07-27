'use strict';

/**
 * Checks for lib/HomeyUsersApi.js, the small replacement for the homey-api
 * package.
 *
 * The token-expiry branch is the reason this file exists: it only fires after
 * roughly two weeks of uptime, so it would otherwise never be exercised until
 * it failed in somebody's house.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const HomeyUsersApi = require('../lib/HomeyUsersApi');

const USERS = {
  u1: {
    id: 'u1', name: 'Ann', present: true, asleep: false,
  },
};

/**
 * @param {Array<object|Function>} responses One per expected fetch call.
 */
function harness(responses, { tokenFails = false } = {}) {
  const calls = {
    token: 0, url: 0, fetch: 0, authHeaders: [],
  };
  const remaining = [...responses];

  const homey = {
    api: {
      getOwnerApiToken: async () => {
        calls.token += 1;
        if (tokenFails) throw new Error('no session');
        return `token-${calls.token}`;
      },
      getLocalUrl: async () => {
        calls.url += 1;
        return 'http://127.0.0.1:80';
      },
    },
  };

  const api = new HomeyUsersApi({ homey });

  // Stub the global fetch the client uses.
  api.request = async function stubbedRequest() {
    const { token, baseUrl } = await this.getSession();
    calls.fetch += 1;
    calls.authHeaders.push(token);
    assert.strictEqual(baseUrl, 'http://127.0.0.1:80');

    const next = remaining.shift();
    if (!next) throw new Error('unexpected extra request');
    return typeof next === 'function' ? next() : next;
  };

  return { api, calls };
}

/** Matches what request() resolves to: a status and an unparsed body string. */
function response(status, body) {
  return { status, body: JSON.stringify(body) };
}

test('returns the user list on a normal 200', async () => {
  const { api, calls } = harness([response(200, USERS)]);
  assert.deepStrictEqual(await api.getUsers(), USERS);
  assert.strictEqual(calls.fetch, 1);
});

test('unwraps a { result } envelope when Homey sends one', async () => {
  const { api } = harness([response(200, { result: USERS })]);
  assert.deepStrictEqual(await api.getUsers(), USERS);
});

test('exposes the same users.getUsers() shape as homey-api', async () => {
  const { api } = harness([response(200, USERS)]);
  // UserStatus calls api.users.getUsers(), not api.getUsers().
  assert.deepStrictEqual(await api.users.getUsers(), USERS);
});

test('an expired token triggers exactly one refresh and then succeeds', async () => {
  const { api, calls } = harness([response(401, {}), response(200, USERS)]);

  assert.deepStrictEqual(await api.getUsers(), USERS);
  assert.strictEqual(calls.fetch, 2, 'one failed call, one retry');
  assert.strictEqual(calls.token, 2, 'a second token was fetched');
  assert.deepStrictEqual(calls.authHeaders, ['token-1', 'token-2'], 'the retry used the new token');
});

test('a 403 is treated the same as a 401', async () => {
  const { api, calls } = harness([response(403, {}), response(200, USERS)]);
  assert.deepStrictEqual(await api.getUsers(), USERS);
  assert.strictEqual(calls.token, 2);
});

test('it does not retry forever when the refresh also fails', async () => {
  const { api, calls } = harness([response(401, {}), response(401, {})]);
  await assert.rejects(() => api.getUsers(), /401/);
  assert.strictEqual(calls.fetch, 2, 'exactly one retry, not a loop');
});

test('a server error is reported, not retried', async () => {
  const { api, calls } = harness([response(500, {})]);
  await assert.rejects(() => api.getUsers(), /500/);
  assert.strictEqual(calls.fetch, 1);
});

test('a malformed body is reported clearly rather than crashing the card', async () => {
  const { api } = harness([{ status: 200, body: '<html>not json</html>' }]);
  await assert.rejects(() => api.getUsers(), /unreadable user list/);
});

test('the token is fetched once and reused across calls', async () => {
  const { api, calls } = harness([response(200, USERS), response(200, USERS), response(200, USERS)]);

  await api.getUsers();
  await api.getUsers();
  await api.getUsers();

  assert.strictEqual(calls.fetch, 3);
  assert.strictEqual(calls.token, 1, 'no needless session churn');
});

/**
 * The tests above stub request() away, which is what let a real auth bug ship:
 * the client sent the bare token and Homey answered 401 "Invalid Session".
 * These drive the genuine node:http path against a throwaway local server.
 */
test('the real request presents the token as a Bearer credential', async () => {
  const seen = {};

  const server = http.createServer((req, res) => {
    seen.auth = req.headers.authorization;
    seen.url = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(USERS));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const homey = {
      api: {
        getOwnerApiToken: async () => 'abc123',
        getLocalUrl: async () => `http://127.0.0.1:${port}`,
      },
    };

    const api = new HomeyUsersApi({ homey });
    assert.deepStrictEqual(await api.getUsers(), USERS);

    assert.strictEqual(seen.auth, 'Bearer abc123', 'a bare token is rejected by Homey as "Invalid Session"');
    assert.strictEqual(seen.url, '/api/manager/users/user');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the real request surfaces a non-2xx status from the server', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('{}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const api = new HomeyUsersApi({
      homey: {
        api: {
          getOwnerApiToken: async () => 'abc123',
          getLocalUrl: async () => `http://127.0.0.1:${port}`,
        },
      },
    });
    await assert.rejects(() => api.getUsers(), /500/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a failed session is not cached, so the next call retries', async () => {
  const homey = {
    api: {
      getOwnerApiToken: async () => {
        throw new Error('Homey not ready');
      },
      getLocalUrl: async () => 'http://127.0.0.1:80',
    },
  };
  const api = new HomeyUsersApi({ homey });

  await assert.rejects(() => api.getUsers(), /Could not start a Homey API session/);
  // If the rejected promise had been cached, this would reject with the same
  // error forever, and the app would never recover from a slow boot.
  assert.strictEqual(api.session, null, 'the failed session was discarded');
});
