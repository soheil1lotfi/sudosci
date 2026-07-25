/* Transcript source: SerpApi's YouTube transcript engine.
 *
 * Instant and cheap compared with realtime audio capture — YouTube already has
 * a caption track, this just reads it. Costs one SerpApi search per video, so
 * results are cached in the document store and never re-fetched for the same
 * video id.
 *
 * Response shape (verified against the live API):
 *   { transcript: [{ start_ms, end_ms, snippet, start_time_text }],
 *     chapters:   [{ chapter, start_ms, end_ms, start_time_text }],
 *     available_transcripts: [{ language_code, serpapi_link }],
 *     search_metadata: { status } }
 */

const ENDPOINT = 'https://serpapi.com/search.json';

export const SOURCE_ID = 'serpapi-youtube';
export const MODEL_ID = 'serpapi/youtube_video_transcript';

/**
 * @param {{videoId: string, apiKey: string, languageCode?: string, signal?: AbortSignal}} options
 * @returns {Promise<{segments: Array, chapters: Array, availableLanguages: string[], languageCode: string|null}>}
 */
export async function fetchTranscript({ videoId, apiKey, languageCode, signal }) {
  if (!apiKey) throw new Error('No SerpApi key set — add one in the extension popup');
  if (!videoId) throw new Error('No YouTube video id');

  const url = new URL(ENDPOINT);
  url.searchParams.set('engine', 'youtube_video_transcript');
  url.searchParams.set('v', videoId);
  url.searchParams.set('api_key', apiKey);
  if (languageCode) url.searchParams.set('language_code', languageCode);

  let response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    throw new Error(`SerpApi unreachable: ${error.message}`);
  }

  const body = await response.json().catch(() => null);

  if (!response.ok || body?.error) {
    const available = (body?.available_transcripts || [])
      .map((t) => t.language_code)
      .filter(Boolean);
    const hint = available.length ? ` (available: ${available.slice(0, 8).join(', ')})` : '';
    throw new Error(`${body?.error || `SerpApi HTTP ${response.status}`}${hint}`);
  }

  const raw = Array.isArray(body?.transcript) ? body.transcript : [];
  if (!raw.length) throw new Error('SerpApi returned no transcript for this video');

  return {
    segments: raw
      .map((item) => ({
        start: msToSeconds(item.start_ms),
        end: msToSeconds(item.end_ms),
        text: typeof item.snippet === 'string' ? item.snippet.trim() : null,
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text)
      .sort((a, b) => a.start - b.start),

    chapters: (body?.chapters || [])
      .map((c) => ({
        title: c.chapter ?? null,
        start: msToSeconds(c.start_ms),
        end: msToSeconds(c.end_ms),
      }))
      .filter((c) => Number.isFinite(c.start)),

    availableLanguages: (body?.available_transcripts || [])
      .map((t) => t.language_code)
      .filter(Boolean),

    languageCode: body?.search_parameters?.language_code ?? languageCode ?? null,
  };
}

function msToSeconds(ms) {
  return Number.isFinite(ms) ? Math.round(ms) / 1000 : NaN;
}
