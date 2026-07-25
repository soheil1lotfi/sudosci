/* Claim source.
 *
 * This is the seam for the real pipeline (transcribe -> detect scientific
 * claim -> verify -> return flagged spans). Today it returns deterministic
 * mock claims so the timeline UI can be built and demoed. Swapping in the
 * backend means replacing the body of `fetchClaims` with a fetch() call —
 * the shape of the returned objects is the contract:
 *
 *   {
 *     id: string,          // stable per claim
 *     time: number,        // seconds into the media, where the claim starts
 *     endTime?: number,    // optional, seconds
 *     severity: 'false' | 'misleading' | 'unverified',
 *     label: string,       // short text for the hover tooltip
 *   }
 */
(() => {
  const NS = window.__SUDOSCI;
  const { hashString, mulberry32 } = NS;

  const MOCK_LABELS = [
    { severity: 'false', label: 'Claim contradicts published evidence' },
    { severity: 'misleading', label: 'Statistic quoted without context' },
    { severity: 'unverified', label: 'No peer-reviewed source found' },
    { severity: 'false', label: 'Study cited does not say this' },
    { severity: 'misleading', label: 'Correlation presented as causation' },
    { severity: 'unverified', label: 'Preprint only — not replicated' },
  ];

  /** Deterministic placeholder claims spread across the media duration. */
  function mockClaims({ platform, mediaId, duration }) {
    if (!Number.isFinite(duration) || duration < 30) return [];

    const rand = mulberry32(hashString(`${platform}:${mediaId}`));
    const count = 3 + Math.floor(rand() * 4); // 3–6 markers
    const claims = [];

    for (let i = 0; i < count; i++) {
      // Spread markers over 5%–95% of the timeline, jittered within their slot.
      const slot = (i + rand()) / count;
      const time = duration * (0.05 + slot * 0.9);
      const pick = MOCK_LABELS[Math.floor(rand() * MOCK_LABELS.length)];
      claims.push({
        id: `${mediaId}-${i}`,
        time,
        endTime: Math.min(duration, time + 12),
        severity: pick.severity,
        label: pick.label,
      });
    }

    return claims.sort((a, b) => a.time - b.time);
  }

  /**
   * @param {{platform: string, mediaId: string, duration: number}} media
   * @returns {Promise<Array>} claims
   */
  async function fetchClaims(media) {
    // TODO: replace with the analysis backend, e.g.
    //   const res = await fetch(`${API}/claims?platform=...&id=...`);
    //   return (await res.json()).claims;
    return mockClaims(media);
  }

  NS.claims = { fetchClaims };
})();
