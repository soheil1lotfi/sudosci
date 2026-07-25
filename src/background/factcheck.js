/* Client for the fact-check backend.
 *
 * Runs in the service worker on purpose: extension background fetches with
 * host_permissions are exempt from CORS, so the backend needs no CORS
 * middleware. A content script calling it directly would be blocked.
 *
 * POST /v1/factcheck is a single blocking request with no streaming — a dozen
 * claims can take 30–120 s — so callers need an indeterminate progress state
 * and a long timeout, not a spinner that gives up at 30 s.
 */

/** Slightly above the backend's own 180 s LLM timeout, to let it answer first. */
export const REQUEST_TIMEOUT_MS = 240_000;

/**
 * @param {object} options
 * @param {string} options.baseUrl        e.g. 'http://localhost:8000'
 * @param {string} [options.apiKey]       omitted when the server runs open
 * @param {object} options.document       a stored transcript document
 * @param {string} [options.responseLanguage] ISO 639-1; default matches the transcript
 * @param {boolean} [options.offline]     skip MCP; everything comes back unverifiable
 * @returns {Promise<object>} FactCheckResponse
 */
export async function runFactCheck({
  baseUrl,
  apiKey,
  document: doc,
  responseLanguage,
  offline = false,
}) {
  const transcript = toTranscript(doc);
  if (!transcript.length) throw new Error('Transcript is empty — nothing to check');

  const body = {
    transcript,
    // Passthrough fields the backend mines for context; harmless if ignored.
    search_metadata: { youtube_video_transcript_url: doc.media?.url ?? undefined },
    search_parameters: { language_code: doc.media?.language ?? undefined },
    offline,
  };
  if (responseLanguage) body.response_language = responseLanguage;

  const response = await post(endpoint(baseUrl, '/v1/factcheck'), body, apiKey);
  return response;
}

/** GET /v1/research/tools — which MCP search tool is live. 503 when unreachable. */
export async function getResearchTools({ baseUrl, apiKey }) {
  return get(endpoint(baseUrl, '/v1/research/tools'), apiKey);
}

/* GET /ready — 200 once the model answers, 503 until then. The body also
   reports the research MCP, which is worth knowing before starting a run: with
   research down every verdict comes back `unverifiable`, and the run still
   costs a minute or two. */
export async function checkReady({ baseUrl }) {
  let response;
  let body = null;
  try {
    response = await fetch(endpoint(baseUrl, '/ready'), { method: 'GET' });
    body = await response.json().catch(() => null);
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error) };
  }

  const research = body?.research || {};
  return {
    ok: response.ok,
    status: response.status,
    modelOk: body?.model?.ok ?? null,
    model: body?.model?.name ?? null,
    // `configured` false means MCP_API_KEY is unset; `ok` false means it is set
    // but unreachable. Both degrade rather than fail.
    researchConfigured: research.configured ?? null,
    researchOk: research.configured ? (research.ok ?? false) : false,
    researchTools: research.tools?.length ?? 0,
    researchError: research.error ?? null,
  };
}

/* ---------- request shaping ---------- */

/** Flatten a stored document into the transcript array the API expects. */
function toTranscript(doc) {
  const segments = (doc?.chunks || []).flatMap((chunk) => chunk.segments || []);
  return segments
    .filter((segment) => segment.text)
    .sort((a, b) => a.start - b.start)
    .map((segment) => ({
      start_ms: Math.round(segment.start * 1000),
      snippet: segment.text,
      start_time_text: formatTimestamp(segment.start),
    }));
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function endpoint(baseUrl, path) {
  if (!baseUrl) throw new Error('No backend URL set — add one in the extension popup');
  // Preserve any path prefix on the base URL (e.g. behind a reverse proxy).
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ''), base).toString();
}

/* ---------- transport ---------- */

async function post(url, body, apiKey) {
  return send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(apiKey) },
    body: JSON.stringify(body),
  });
}

async function get(url, apiKey) {
  return send(url, { method: 'GET', headers: authHeader(apiKey) });
}

function authHeader(apiKey) {
  // The server's gate is a no-op when API_KEY is unset, so send nothing rather
  // than an empty bearer token.
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function send(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Backend did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Cannot reach the backend at ${url} — ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(describeError(response.status, payload));
  return payload;
}

function describeError(status, payload) {
  const detail = payload?.detail;

  if (status === 401) return 'Backend rejected the API key (401)';
  if (status === 422) {
    // FastAPI's validation shape: [{ loc, msg, type }]
    const issues = Array.isArray(detail)
      ? detail.map((d) => `${(d.loc || []).slice(1).join('.') || 'body'}: ${d.msg}`)
      : [String(detail ?? 'invalid request')];
    return `Backend rejected the request (422) — ${issues.slice(0, 3).join('; ')}`;
  }
  if (status === 503) return `Backend not ready (503) — ${textOf(detail) || 'try again shortly'}`;
  if (status === 502) return textOf(detail) || 'model server error (502)';
  if (status === 500) {
    /* The backend documents 502 for a failed model call, but only wraps decode
       errors in LLMError — a transport failure (vLLM down) escapes as a bare
       500. That is by far the most common 500, so name it. */
    return (
      `Backend error 500${detail ? ` — ${textOf(detail)}` : ''}` +
      ' — often the model server is unreachable; check the backend log'
    );
  }
  return `Backend error ${status}${detail ? ` — ${textOf(detail)}` : ''}`;
}

function textOf(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((d) => d?.msg ?? String(d)).join('; ');
  return detail ? JSON.stringify(detail) : '';
}
