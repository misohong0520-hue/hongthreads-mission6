import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const hash = b => createHash('sha256').update(b).digest('hex');
const emptyHash = hash(Buffer.alloc(0));
const captures = process.argv.slice(2);
if (!captures.length) throw new Error('Pass exact REA capture JSON paths; no sample capture is imported automatically.');
await mkdir(join(root, 'objects'), { recursive: true });
await mkdir(join(root, 'derived'), { recursive: true });
const records = [], sources = [], rejected = [];
const decodeBody = body => {
  if (!body || body.state !== 'captured') return null;
  if (typeof body.content !== 'string') throw new Error('Captured body is not a string.');
  const encoding = body.encoding?.toLowerCase();
  if (!['base64', 'utf8', 'utf-8'].includes(encoding)) throw new Error('Unknown body encoding: ' + encoding);
  const bytes = Buffer.from(body.content, encoding === 'base64' ? 'base64' : 'utf8');
  const sha256 = hash(bytes);
  if (body.bytes !== bytes.length || body.sha256 !== sha256) throw new Error('REA retained-body digest/size mismatch.');
  return { bytes, sha256, size: bytes.length, encoding: body.encoding, representation: body.representation, media_type: body.media_type, redacted: body.redacted === true };
};
const safeHeaders = event => Object.fromEntries((event?.headers?.items ?? [])
  .filter(h => !h.redacted && ['content-type','content-language','location'].includes(h.name.toLowerCase()) && typeof h.value === 'string')
  .map(h => [h.name.toLowerCase(), h.value]));
let primaryOrigin = null;
for (const capturePath of captures) {
  const path = resolve(capturePath);
  const bytes = await readFile(path);
  const evidence = JSON.parse(bytes.toString('utf8'));
  if (evidence.operation !== 'capture_browser_scenario') throw new Error('Expected one REA browser scenario Evidence: ' + path);
  const capture = evidence.normalized_result;
  if (!capture?.events?.items || !Array.isArray(capture.steps)) throw new Error('Invalid REA browser capture shape.');
  const finalUrl = capture.steps.at(-1)?.after_url?.url;
  if (!primaryOrigin && finalUrl) primaryOrigin = new URL(finalUrl).origin;
  const source = { path, sha256: hash(bytes), evidence_id: evidence.evidence_id, operation: evidence.operation,
    final_url: finalUrl, completeness: capture.completeness };
  sources.push(source);
  const txns = new Map();
  for (const event of capture.events.items) {
    if (!event.transaction_id) continue;
    let txn = txns.get(event.transaction_id);
    if (!txn) { txn = { id: event.transaction_id }; txns.set(event.transaction_id, txn); }
    if (event.kind === 'request') txn.request = event;
    if (event.kind === 'response') txn.response = event;
    if (event.kind === 'network-content' && event.phase === 'request') txn.requestContent = event;
    if (event.kind === 'network-content' && event.phase === 'response') txn.responseContent = event;
    if (event.kind === 'request-failed') txn.failure = event.failure;
  }
  for (const txn of txns.values()) {
    const req = txn.request;
    if (!req?.url?.url) {
      rejected.push({ evidence_id: evidence.evidence_id, transaction_id: txn.id, reason: 'request metadata unavailable' });
      continue;
    }
    const original = new URL(req.url.url);
    if (!['http:', 'https:'].includes(original.protocol)) {
      rejected.push({ evidence_id: evidence.evidence_id, transaction_id: txn.id, reason: 'non-HTTP URL' });
      continue;
    }
    const responseBody = decodeBody(txn.responseContent?.body);
    const requestBody = decodeBody(txn.requestContent?.body);
    const method = req.method.toUpperCase();
    const requestKnownEmpty = ['GET','HEAD'].includes(method) && !requestBody;
    const responseHeaders = safeHeaders(txn.responseContent);
    const requestRedacted = requestBody?.redacted ?? false;
    const responseRedacted = responseBody?.redacted ?? false;
    const bodyState = txn.responseContent?.body?.state ?? 'not-recorded';
    const requestBodyHash = requestBody?.sha256 ?? (requestKnownEmpty ? emptyHash : null);
    const bodyAvailable = responseBody !== null;
    const status = txn.response?.status ?? null;
    const redirectWithoutLocation = status >= 300 && status < 400 && status !== 304 && !responseHeaders.location;
    const replayable = status !== null && bodyAvailable && requestBodyHash !== null &&
      !requestRedacted && !responseRedacted && !redirectWithoutLocation;
    const record = {
      id: 'rec_' + hash(Buffer.from(evidence.evidence_id + ':' + txn.id)),
      evidence_id: evidence.evidence_id, capture_sha256: source.sha256,
      transaction_id: txn.id, method, original_url: original.href, origin: original.origin,
      pathname: original.pathname, search: original.search, resource_type: req.resource_type,
      request_header_names: req.header_names ?? [],
      rsc: (req.header_names ?? []).some(h => h.toLowerCase() === 'rsc'),
      request_body: { state: txn.requestContent?.body?.state ?? 'not-recorded', sha256: requestBodyHash,
        bytes: requestBody?.size ?? (requestKnownEmpty ? 0 : null), redacted: requestRedacted,
        interpretation: requestKnownEmpty ? 'HTTP GET/HEAD empty request body' : 'exact retained request body' },
      response: { status, headers: responseHeaders, body_state: bodyState,
        object_sha256: responseBody?.sha256 ?? null, bytes: responseBody?.size ?? null,
        media_type: responseBody?.media_type ?? null, representation: responseBody?.representation ?? null,
        redacted: responseRedacted },
      replayable, limitations: [
        ...(!bodyAvailable ? ['Response bytes were not retained by REA.'] : []),
        ...(requestBodyHash === null ? ['Request bytes were not retained; exact request matching is unavailable.'] : []),
        ...(requestRedacted || responseRedacted ? ['REA redaction prevents original-byte replay.'] : []),
        ...(redirectWithoutLocation ? ['Redirect Location header was not retained.'] : []),
        ...(txn.failure ? ['Observed original request failure: ' + txn.failure] : [])
      ]
    };
    if (responseBody) {
      const target = join(root, 'objects', responseBody.sha256);
      try { await writeFile(target, responseBody.bytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (hash(await readFile(target)) !== responseBody.sha256) throw new Error('Existing content object differs.');
      }
    }
    records.push(record);
  }
}
if (!primaryOrigin) throw new Error('No target origin observed.');
const canonicalUrl = value => { const u = new URL(value); u.hash = ''; u.searchParams.delete('_rsc'); return u.href; };
const keyOf = r => JSON.stringify([r.method, canonicalUrl(r.original_url), r.request_body.sha256, r.rsc]);
const versions = new Map();
for (const record of records.filter(r => r.replayable)) {
  const key = keyOf(record); const list = versions.get(key) ?? []; list.push(record); versions.set(key, list);
}
const conflicts = [...versions.values()].filter(v => new Set(v.map(r => r.response.status + ':' + r.response.object_sha256)).size > 1)
  .map(v => ({ record_ids: v.map(r => r.id), method: v[0].method, original_url: v[0].original_url,
    policy: 'latest supplied capture wins; earlier variants remain recorded' }));
const objects = [...new Set(records.map(r => r.response.object_sha256).filter(Boolean))];
const manifest = { schema: 'rea-http-replay-manifest-v1', generated_at: new Date().toISOString(),
  primary_origin: primaryOrigin, sources, matching: { query: 'exact business query with only volatile _rsc removed',
  body: 'exact SHA-256', rsc: 'RSC request-header presence distinguishes Flight from document',
  variants: 'latest supplied capture wins, all retained variants preserved' },
  objects, records, conflicts, rejected,
  summary: { captures: sources.length, requests: records.length, replayable_records: records.filter(r => r.replayable).length,
    unavailable_records: records.filter(r => !r.replayable).length, unique_objects: objects.length,
    exact_match_keys: versions.size, conflicting_match_keys: conflicts.length },
  limitations: [
    'These are immutable recorded HTTP observations, not original backend source or general server behavior.',
    'No remote proxy or fallback exists; an unrecorded request returns HTTP 501.',
    'Objects preserve exact REA-retained browser-decoded bytes, not compressed wire bytes.',
    'Credentials, Set-Cookie, authorization headers and cookies are never replayed.',
    'Response header values were not requested in some captures. Only known safe retained headers are served.',
    'Derived HTML inserts a generic local URL relocation adapter and a self-only CSP; raw objects remain unchanged.',
    'Original script bodies are not modified. Business logic, subscription responses and original access decisions remain unchanged.',
    'Only recorded finite requests replay. Different searches, writes, time-dependent responses and unseen states remain unknown.'
  ] };
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(root, 'coverage.json'), JSON.stringify({ ...manifest.summary, primary_origin: primaryOrigin,
  sources: sources.map(s => ({ evidence_id: s.evidence_id, sha256: s.sha256, final_url: s.final_url })),
  api_routes: [...new Set(records.filter(r => r.origin === primaryOrigin && r.pathname.startsWith('/api/')).map(r => r.method + ' ' + r.pathname + r.search))],
  conflicts: conflicts.map(c => ({ method: c.method, path: new URL(c.original_url).pathname, variants: c.record_ids.length })),
  limitations: manifest.limitations }, null, 2) + '\n');
console.log(JSON.stringify(manifest.summary));
