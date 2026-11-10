import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const maximumBodyBytes = 64 * 1024;
const privateHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
};

const send = (res, status, bytes, contentType, extraHeaders = {}) => {
  res.writeHead(status, {
    ...privateHeaders,
    'content-type': contentType,
    'content-length': bytes.length,
    ...extraHeaders
  });
  res.end(bytes);
};
const sendJson = (res, status, value, extraHeaders) =>
  send(res, status, Buffer.from(JSON.stringify(value)), 'application/json; charset=utf-8', extraHeaders);

const readBody = req => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  let settled = false;
  const cleanup = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('aborted', onAborted);
    req.off('error', onError);
  };
  const fail = code => {
    if (settled) return;
    settled = true;
    cleanup();
    // Discard the remaining body without retaining any submitted secret bytes.
    req.once('error', () => {});
    req.resume();
    chunks.length = 0;
    reject(Object.assign(new Error('Invalid session setup request.'), { code }));
  };
  const onData = chunk => {
    size += chunk.length;
    if (size > maximumBodyBytes) return fail('body-limit');
    chunks.push(chunk);
  };
  const onEnd = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(Buffer.concat(chunks));
  };
  const onAborted = () => fail('body-aborted');
  const onError = () => fail('body-read-failed');
  req.on('data', onData);
  req.once('end', onEnd);
  req.once('aborted', onAborted);
  req.once('error', onError);
});

/** Local control routes only. The caller must validate Host/Fetch-Site first. */
export const createSessionRoutes = async ({ bridge, setupToken }) => {
  if (typeof setupToken !== 'string' || setupToken.length < 32)
    throw new Error('A random local session setup token is required.');
  const html = await readFile(join(import.meta.dirname, 'session-setup.html'));
  const script = await readFile(join(import.meta.dirname, 'session-setup.js'));
  const tokenBytes = Buffer.from(setupToken);
  const validToken = value => {
    if (typeof value !== 'string') return false;
    const supplied = Buffer.from(value);
    return supplied.length === tokenBytes.length && timingSafeEqual(supplied, tokenBytes);
  };
  const status = async () => ({ ...await bridge.status(), setupToken });

  return async (req, res, local) => {
    const pathname = local.pathname;
    if (!['/__live', '/__live/', '/__live/setup.js', '/__live/status', '/__live/session'].includes(pathname))
      return false;
    const method = req.method?.toUpperCase();
    const allowed = pathname === '/__live/session' ? ['POST', 'DELETE'] : ['GET'];
    if (!allowed.includes(method)) {
      req.resume();
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allowed.join(', ') });
      return true;
    }

    try {
      if (pathname === '/__live' || pathname === '/__live/') {
        send(res, 200, html, 'text/html; charset=utf-8');
        return true;
      }
      if (pathname === '/__live/setup.js') {
        send(res, 200, script, 'application/javascript; charset=utf-8');
        return true;
      }
      if (pathname === '/__live/status') {
        sendJson(res, 200, await status());
        return true;
      }

      if (req.headers.origin !== 'http://' + req.headers.host) {
        req.resume();
        sendJson(res, 403, { error: 'same_origin_required' });
        return true;
      }
      if (!validToken(req.headers['x-rea-setup-token'])) {
        req.resume();
        sendJson(res, 403, { error: 'setup_token_invalid' });
        return true;
      }
      if (method === 'DELETE') {
        req.resume();
        await bridge.clear();
        sendJson(res, 200, await status());
        return true;
      }

      const mediaType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== 'application/json') {
        req.resume();
        sendJson(res, 415, { error: 'json_required' });
        return true;
      }
      const declaredSize = Number(req.headers['content-length'] ?? 0);
      if (declaredSize > maximumBodyBytes) {
        req.resume();
        sendJson(res, 413, { error: 'session_setup_body_limit' }, { Connection: 'close' });
        return true;
      }
      let bytes;
      try { bytes = await readBody(req); }
      catch (error) {
        sendJson(res, error.code === 'body-limit' ? 413 : 400,
          { error: error.code === 'body-limit' ? 'session_setup_body_limit' : 'invalid_request_body' },
          error.code === 'body-limit' ? { Connection: 'close' } : {});
        return true;
      }
      let payload;
      try { payload = JSON.parse(bytes.toString('utf8')); }
      catch {
        sendJson(res, 400, { error: 'invalid_json' });
        return true;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, { error: 'invalid_session_input' });
        return true;
      }
      const result = await bridge.configure(payload);
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599)
        throw new Error('Invalid session bridge result.');
      sendJson(res, result.status, result.body);
      return true;
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'session_setup_failed' });
      else res.destroy();
      return true;
    }
  };
};
