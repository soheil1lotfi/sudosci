/* Claim source.
 *
 * Claims come from the fact-check backend via the service worker (the content
 * script cannot call it directly — a cross-origin fetch from a page context is
 * subject to CORS, the background's is not). Results are stored per video, so
 * this is a lookup, not a request: the analysis is triggered from the popup or
 * by the auto-run setting.
 *
 * A marker needs `start_ms`, which the backend omits when it could not locate
 * the quote in the transcript. Those claims are still returned here, under
 * `unplaced`, so the UI can account for them instead of silently losing them.
 */
(() => {
  const NS = window.__SUDOSCI;
  const { verdictOf } = NS;

  /**
   * @param {{platform: string, mediaId: string}} media
   * @returns {Promise<{claims: Array, unplaced: Array, analysis: object|null}>}
   */
  async function fetchClaims({ platform, mediaId }) {
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'claims:get',
        platform,
        mediaId,
      });
    } catch {
      return empty(); // worker asleep or extension reloading
    }

    const analysis = result?.analysis;
    if (!analysis?.claims?.length) return empty(analysis ?? null);

    const showAll = !!result.showAllVerdicts;
    const placed = [];
    const unplaced = [];

    analysis.claims.forEach((claim, index) => {
      const verdict = verdictOf(claim.verdict);
      if (!showAll && !verdict.marker) return;

      const entry = {
        id: `${mediaId}-${index}`,
        verdict: claim.verdict,
        // The tooltip shows the decontextualised restatement, not the raw quote.
        label: claim.claim || claim.quote || verdict.label,
        claim,
      };

      if (Number.isFinite(claim.start_ms)) placed.push({ ...entry, time: claim.start_ms / 1000 });
      else unplaced.push(entry);
    });

    // The backend returns claims in transcript order only incidentally.
    placed.sort((a, b) => a.time - b.time);

    return { claims: placed, unplaced, analysis };
  }

  function empty(analysis = null) {
    return { claims: [], unplaced: [], analysis };
  }

  NS.claims = { fetchClaims };
})();
