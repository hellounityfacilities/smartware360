'use strict';
/**
 * A small router over node's http module.
 *
 * No framework. The whole surface is a few dozen routes, the matching is
 * straightforward, and every dependency in a system holding a customer's
 * inventory is something that has to be patched for the life of the product.
 */

function createRouter() {
  const routes = [];

  function add(method, pattern, handler, options = {}) {
    const names = [];
    const regex = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, n) => {
      names.push(n); return '([^/]+)';
    }).replace(/\//g, '\\/') + '$');
    routes.push({ method, pattern, regex, names, handler, options });
  }

  const router = {
    get:  (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put:  (p, h, o) => add('PUT', p, h, o),
    del:  (p, h, o) => add('DELETE', p, h, o),
    routes,

    match(method, path) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.regex.exec(path);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
      return null;
    }
  };
  return router;
}

/** Everything a handler receives, whether from a socket or from a test. */
function makeRequest({ method, path, query, body, headers, params }) {
  return {
    method, path,
    query: query || {},
    body: body || {},
    headers: headers || {},
    params: params || {},
    session: (headers && (headers['x-session'] || headers['X-Session'])) || null,
    ip: (headers && headers['x-forwarded-for']) || null,
    device: (headers && headers['user-agent']) || null,
    /** Read a query parameter as a number, or null. */
    numParam(name) {
      const v = this.query[name];
      if (v === undefined || v === '' || v === null) return null;
      const n = Number(v);
      if (Number.isNaN(n)) throw new HttpError(`"${name}" must be a number.`, 400);
      return n;
    }
  };
}

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Dispatch. Errors become a JSON body with a message a person can read — never
 * a stack trace, and never the raw database text, which can leak schema detail.
 */
async function dispatch(router, deps, reqInput) {
  const hit = router.match(reqInput.method, reqInput.path);
  if (!hit) return { status: 404, body: { error: 'No such endpoint.' } };

  const req = makeRequest(Object.assign({}, reqInput, { params: hit.params }));
  try {
    const result = await hit.route.handler(req, deps);
    if (result && result.__raw) return result;
    return { status: hit.route.options.status || 200, body: result === undefined ? {} : result };
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) {
      deps.log && deps.log('error', `${reqInput.method} ${reqInput.path}`, e.message, e.stack);
      return { status, body: { error: 'Something went wrong handling that request.' } };
    }
    return { status, body: { error: e.message, detail: e.detail || undefined } };
  }
}

/** Bind the router to a real socket. */
function listen(router, deps, port) {
  const http = require('http');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 2 * 1024 * 1024) {           // reject oversized bodies early
          res.writeHead(413, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'That request body is too large.' }));
        }
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try { body = JSON.parse(raw); }
        catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'The request body was not valid JSON.' }));
        }
      }
    }
    const out = await dispatch(router, deps, {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers
    });
    res.writeHead(out.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(JSON.stringify(out.body));
  });
  server.listen(port);
  return server;
}

module.exports = { createRouter, dispatch, listen, makeRequest, HttpError };
