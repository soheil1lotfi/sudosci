/* Transcript documents live in chrome.storage.local, one key per media item. */

const KEY_PREFIX = 'transcript:';
const ANALYSIS_PREFIX = 'analysis:';

const keyFor = (documentId) => `${KEY_PREFIX}${documentId}`;
const analysisKeyFor = (documentId) => `${ANALYSIS_PREFIX}${documentId}`;

/* Fact-check results are stored beside the transcript rather than inside it:
   one transcript can be re-analysed, and the two have different lifetimes. */

export async function getAnalysis(documentId) {
  const key = analysisKeyFor(documentId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

export async function putAnalysis(analysis) {
  await chrome.storage.local.set({ [analysisKeyFor(analysis.documentId)]: analysis });
  return analysis;
}

export async function deleteAnalysis(documentId) {
  await chrome.storage.local.remove(analysisKeyFor(documentId));
}

export async function getDocument(documentId) {
  const key = keyFor(documentId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

export async function putDocument(doc) {
  await chrome.storage.local.set({ [keyFor(doc.documentId)]: doc });
  return doc;
}

export async function deleteDocument(documentId) {
  await chrome.storage.local.remove(keyFor(documentId));
}

export async function listDocuments() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(KEY_PREFIX))
    .map(([, doc]) => doc)
    .sort((a, b) => String(b.capture?.startedAt).localeCompare(String(a.capture?.startedAt)));
}

/** Compact summary for the popup — avoids shipping every chunk to render a count. */
export function summarize(doc) {
  if (!doc) return null;
  const chunks = doc.chunks || [];
  const covered = (doc.capture?.coverage || []).reduce((acc, [s, e]) => acc + (e - s), 0);
  return {
    documentId: doc.documentId,
    source: doc.capture?.source ?? null,
    title: doc.media?.title ?? null,
    duration: doc.media?.duration ?? null,
    chunks: chunks.length,
    segments: chunks.reduce((acc, c) => acc + (c.segments?.length || 0), 0),
    errors: chunks.filter((c) => c.status === 'error').length,
    coveredSeconds: Math.round(covered),
    startedAt: doc.capture?.startedAt ?? null,
    completedAt: doc.capture?.completedAt ?? null,
  };
}
