/**
 * Arabic Audio Worker
 *
 * Routes:
 *   GET    /audio/<filename>   public, returns audio bytes
 *   POST   /upload             auth, multipart with `file` and `filename`
 *   GET    /list               auth, returns { files: [...] }
 *   DELETE /audio/<filename>   auth, removes one object
 *   OPTIONS *                  CORS preflight
 *   *                          404
 */

const ALLOWED_ORIGINS = [
  'https://toucans.github.io',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
];

const AUDIO_PREFIX = '/audio/';
const WORDLIST_KEY = 'wordlist.json';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }

      if (request.method === 'GET' && url.pathname.startsWith(AUDIO_PREFIX)) {
        return await handleGetAudio(url, env, cors);
      }

      if (request.method === 'POST' && url.pathname === '/upload') {
        if (!isAuthed(request, env)) return jsonError('unauthorized', 401, cors);
        return await handleUpload(request, url, env, cors);
      }

      if (request.method === 'GET' && url.pathname === '/list') {
        if (!isAuthed(request, env)) return jsonError('unauthorized', 401, cors);
        return await handleList(env, cors);
      }

      if (request.method === 'DELETE' && url.pathname.startsWith(AUDIO_PREFIX)) {
        if (!isAuthed(request, env)) return jsonError('unauthorized', 401, cors);
        return await handleDelete(url, env, cors);
      }

      if (request.method === 'GET' && url.pathname === '/wordlist') {
        return await handleGetWordlist(env, cors);
      }

      if (request.method === 'POST' && url.pathname === '/wordlist') {
        if (!isAuthed(request, env)) return jsonError('unauthorized', 401, cors);
        return await handlePostWordlist(request, env, cors);
      }

      return jsonError('not found', 404, cors);
    } catch (err) {
      return jsonError(err && err.message ? err.message : 'server error', 500, cors);
    }
  },
};

async function handleGetAudio(url, env, cors) {
  const key = decodeURIComponent(url.pathname.slice(AUDIO_PREFIX.length));
  if (!key) return jsonError('missing key', 400, cors);
  const obj = await env.BUCKET.get(key);
  if (!obj) return jsonError('not found', 404, cors);
  const headers = new Headers(cors);
  const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || guessContentType(key);
  headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=86400');
  if (obj.size != null) headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}

async function handleUpload(request, url, env, cors) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    return jsonError('expected multipart/form-data', 400, cors);
  }
  const form = await request.formData();
  const file = form.get('file');
  const filenameRaw = form.get('filename');
  if (!file || typeof file === 'string') return jsonError('missing file', 400, cors);
  if (!filenameRaw || typeof filenameRaw !== 'string') return jsonError('missing filename', 400, cors);

  const filename = sanitizeFilename(filenameRaw);
  if (!filename) return jsonError('invalid filename', 400, cors);

  const contentType = file.type || guessContentType(filename);
  await env.BUCKET.put(filename, file.stream(), {
    httpMetadata: { contentType },
  });

  const audioUrl = `${url.origin}${AUDIO_PREFIX}${encodeURIComponent(filename)}`;
  return jsonResponse({ ok: true, url: audioUrl, filename }, cors);
}

async function handleList(env, cors) {
  const files = [];
  let cursor = undefined;
  // R2 list is paginated; loop until exhausted (capped to a reasonable number).
  for (let i = 0; i < 50; i++) {
    const listed = await env.BUCKET.list({ limit: 1000, cursor });
    for (const o of listed.objects) {
      if (o.key === WORDLIST_KEY) continue; // not an audio file
      files.push(o.key);
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return jsonResponse({ files }, cors);
}

async function handleDelete(url, env, cors) {
  const key = decodeURIComponent(url.pathname.slice(AUDIO_PREFIX.length));
  if (!key) return jsonError('missing key', 400, cors);
  await env.BUCKET.delete(key);
  return jsonResponse({ ok: true, filename: key }, cors);
}

async function handleGetWordlist(env, cors) {
  const obj = await env.BUCKET.get(WORDLIST_KEY);
  if (!obj) return jsonError('not found', 404, cors);
  const text = await obj.text();
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(text, { headers });
}

async function handlePostWordlist(request, env, cors) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    return jsonError('expected application/json', 400, cors);
  }
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonError('invalid json', 400, cors); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('body must be a json object', 400, cors);
  }

  const clientBase = body.lastModified == null ? null : String(body.lastModified);

  const existing = await env.BUCKET.get(WORDLIST_KEY);
  if (existing) {
    let serverData;
    try { serverData = JSON.parse(await existing.text()); }
    catch (e) { serverData = { lastModified: null }; }
    const serverLM = serverData.lastModified || null;
    if (clientBase !== serverLM) {
      return jsonResponse(
        { ok: false, error: 'conflict', current: serverData },
        cors,
        409
      );
    }
  }

  const newLastModified = new Date().toISOString();
  // Store the body verbatim with a server-issued lastModified.
  const { lastModified: _ignored, ...rest } = body;
  const payload = JSON.stringify({ ...rest, lastModified: newLastModified }, null, 2);
  await env.BUCKET.put(WORDLIST_KEY, payload, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return jsonResponse({ ok: true, lastModified: newLastModified }, cors);
}

function isAuthed(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  const expected = env.UPLOAD_PASSWORD;
  if (!expected) return false;
  // Constant-time-ish compare (worker strings are short, but avoid early exit anyway).
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

function sanitizeFilename(name) {
  // Strip path separators and control chars; keep Unicode (Arabic) intact.
  const cleaned = String(name).replace(/[\\/\x00-\x1f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  if (cleaned.length > 256) return null;
  return cleaned;
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function jsonError(msg, status, cors) {
  return jsonResponse({ ok: false, error: msg }, cors, status);
}

function guessContentType(name) {
  const ext = name.toLowerCase().split('.').pop();
  const map = {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    webm: 'audio/webm',
    flac: 'audio/flac',
  };
  return map[ext] || 'application/octet-stream';
}
