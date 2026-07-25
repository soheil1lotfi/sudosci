/* Transcript source: SerpApi's YouTube transcript engine.
 *
 * Instant and cheap compared with realtime audio capture — YouTube already has
 * a caption track, this just reads it. Costs one SerpApi search per video, so
 * results are cached in the document store and never re-fetched for the same
 * video id.
 *
 * Response shape (verified against the live API):
 *   { transcript: [{ start_ms, end_ms, snippet, start_time_text }],
 *     chapters:   [{ chapter, start_ms, end_ms }],
 *     available_transcripts: [{ language_name, language_code, type, title,
 *                               selected, serpapi_link }],
 *     search_parameters: { language_code },
 *     search_metadata: { id, status } }
 *
 * Worth knowing about the engine itself:
 *  - If the requested language_code is unavailable, it falls back to the first
 *    language the video does have rather than failing. The language actually
 *    used comes back in search_parameters.language_code.
 *  - Repeats of an identical query inside an hour are served from SerpApi's
 *    cache, free and not counted against the monthly quota.
 */

const ENDPOINT = 'https://serpapi.com/search.json';

export const SOURCE_ID = 'serpapi-youtube';
export const MODEL_ID = 'serpapi/youtube_video_transcript';

/**
 * @param {object} options
 * @param {string} options.videoId
 * @param {string} options.apiKey
 * @param {string} [options.languageCode] two-letter or extended, e.g. 'en', 'zh-Hans'
 * @param {string} [options.type] 'asr' to force the auto-generated track
 * @param {string} [options.title] a named transcript variant, e.g. 'Twitch Chat - Simple'
 * @param {AbortSignal} [options.signal]
 */
export async function fetchTranscript({ videoId, apiKey, languageCode, type, title, signal }) {
  if (!apiKey) throw new Error('No SerpApi key set — add one in the extension popup');
  if (!videoId) throw new Error('No YouTube video id');

  const url = new URL(ENDPOINT);
  url.searchParams.set('engine', 'youtube_video_transcript');
  url.searchParams.set('v', videoId);
  url.searchParams.set('api_key', apiKey);
  if (languageCode) url.searchParams.set('language_code', languageCode);
  // Leave `type` unset by default: the engine then returns the track YouTube
  // marks as selected, which is a human caption track when one exists and only
  // falls back to ASR otherwise. Forcing 'asr' would discard the better one.
  if (type) url.searchParams.set('type', type);
  if (title) url.searchParams.set('title', title);

  let response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    throw new Error(`SerpApi unreachable: ${error.message}`);
  }

  const body = await response.json().catch(() => null);
  const status = body?.search_metadata?.status;

  if (!response.ok || body?.error || status === 'Error') {
    const available = (body?.available_transcripts || [])
      .map((t) => t.language_code)
      .filter(Boolean);
    const hint = available.length
      ? ` (available: ${[...new Set(available)].slice(0, 8).join(', ')})`
      : '';
    throw new Error(`${body?.error || `SerpApi HTTP ${response.status}`}${hint}`);
  }

  const raw = Array.isArray(body?.transcript) ? body.transcript : [];
  if (!raw.length) throw new Error('SerpApi returned no transcript for this video');

  const availableTranscripts = (body?.available_transcripts || []).map((t) => ({
    languageName: t.language_name ?? null,
    languageCode: t.language_code ?? null,
    type: t.type ?? null,
    title: t.title ?? null,
    selected: !!t.selected,
  }));

  const { segments, endsEstimated } = normaliseCues(raw);
  if (!segments.length) {
    throw new Error('SerpApi returned a transcript with no usable cues');
  }

  return {
    segments,
    endsEstimated,

    chapters: (body?.chapters || [])
      .map((c) => ({
        title: c.chapter ?? null,
        start: msToSeconds(c.start_ms),
        end: msToSeconds(c.end_ms),
      }))
      .filter((c) => Number.isFinite(c.start)),

    availableTranscripts,
    availableLanguages: [
      ...new Set(availableTranscripts.map((t) => t.languageCode).filter(Boolean)),
    ],

    // The engine falls back when the requested language is missing, so this is
    // the language actually returned — not necessarily the one asked for.
    languageCode: body?.search_parameters?.language_code ?? languageCode ?? null,
    transcriptType: body?.search_parameters?.type ?? null,
    searchId: body?.search_metadata?.id ?? null,
  };
}

/* Not every caption track carries end_ms — plenty return start_ms only. A cue
   then runs until the next one starts, and the last cue gets a length estimated
   from how much text it holds. Dropping those cues would silently throw the
   whole transcript away. */
function normaliseCues(raw) {
  const cues = raw
    .map((item) => ({
      start: msToSeconds(item.start_ms),
      end: msToSeconds(item.end_ms),
      text: typeof item.snippet === 'string' ? item.snippet.trim() : null,
    }))
    .filter((cue) => Number.isFinite(cue.start) && cue.text)
    .sort((a, b) => a.start - b.start);

  let endsEstimated = false;

  const segments = cues.map((cue, i) => {
    if (Number.isFinite(cue.end) && cue.end > cue.start) return cue;

    endsEstimated = true;
    const nextStart = cues[i + 1]?.start;
    const end =
      Number.isFinite(nextStart) && nextStart > cue.start
        ? nextStart
        : cue.start + speakingSeconds(cue.text);
    return { ...cue, end };
  });

  return { segments, endsEstimated };
}

/** Rough spoken length of a line, at ~2.7 words per second. */
function speakingSeconds(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(30, Math.max(1, words / 2.7));
}

function msToSeconds(ms) {
  return Number.isFinite(ms) ? Math.round(ms) / 1000 : NaN;
}
