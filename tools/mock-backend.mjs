/* Mock of the fact-check API, matching main.py + schemas.py as documented:
   - bearer auth (no-op when MOCK_API_KEY unset), 401 on mismatch
   - 422 FastAPI validation shape when transcript and text are both missing
   - response_model_exclude_none: unset optional fields are ABSENT, not null
   - citations pre-sorted strongest tier first, exact before fuzzy
   - a verdict backed by evidence always has >= 1 citation                      */
import http from 'node:http';

const KEY = process.env.MOCK_API_KEY || '';
const DELAY = Number(process.env.MOCK_DELAY_MS || 300);
const MODE = process.env.MOCK_MODE || 'ok'; // ok | offline | 502 | slow

const strip = (o) => JSON.parse(JSON.stringify(o, (_, v) => (v === null ? undefined : v)));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/health') return send(200, { status: 'ok' });
  if (url.pathname === '/ready') {
    // Shape from backend/app/main.py:ready
    const researchOk = MODE !== 'offline';
    return send(200, {
      model: { ok: true, name: 'google/gemma-4-12B-it' },
      research: researchOk
        ? { configured: true, ok: true, tools: ['search', 'fetch'] }
        : { configured: false },
      status: 'ready',
    });
  }

  const auth = req.headers.authorization || '';
  if (KEY && auth !== `Bearer ${KEY}`) return send(401, { detail: 'invalid token' });

  if (url.pathname === '/v1/research/tools') {
    return send(200, { tools: [{ name: 'search', mcp_tool: 'web_search', description: 'mock' }] });
  }

  if (url.pathname === '/v1/factcheck' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');

    if (!Array.isArray(body.transcript)?.valueOf() && !String(body.text || '').trim()) {
      if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
        return send(422, { detail: [{ loc: ['body', 'transcript'], msg: 'field required', type: 'value_error.missing' }] });
      }
    }
    if (MODE === '502') return send(502, { detail: 'model server error: upstream refused' });
    if (MODE === 'slow') await new Promise((r) => setTimeout(r, 300000));
    await new Promise((r) => setTimeout(r, DELAY));

    const cues = body.transcript || [];
    const at = (i) => cues[Math.min(i, cues.length - 1)] || {};
    const offline = MODE === 'offline' || body.offline === true;

    const claims = [
      {
        quote: at(1).snippet || 'quoted span',
        claim: 'Gzip compression alone can reconstruct language family trees.',
        claim_type: 'factual',
        verdict: offline ? 'unverifiable' : 'supported',
        confidence: 0.82,
        explanation: 'The 2002 Benedetto et al. paper reports exactly this result using a compression-based distance.',
        citations: offline ? [] : [
          { source_id: 's1', url: 'https://example.org/prl-2002', title: 'Language Trees and Zipping (Phys. Rev. Lett.)',
            quoted_span: 'we obtain a language tree consistent with linguistic classification',
            stance: 'supports', source_tier: 'peer_reviewed', quote_exact: true,
            venue: 'Physical Review Letters', year: '2002', doi: '10.1103/PhysRevLett.88.048702',
            citation_count: 1204, peer_reviewed: true },
          { source_id: 's2', url: 'https://example.org/review', title: 'Compression-based similarity: a review',
            quoted_span: 'subsequent work replicated the clustering result',
            stance: 'partial', source_tier: 'science_journalism', quote_exact: false },
        ],
        start_ms: at(1).start_ms ?? 34920,
        start_time_text: at(1).start_time_text ?? '0:34',
        searches_used: offline ? 0 : 3,
        adjustments: offline ? ['research unavailable: downgraded to unverifiable'] : [],
      },
      {
        quote: at(6).snippet || 'second quoted span',
        claim: 'Cross-entropy is the average bits per symbol when coding P with a code optimised for Q.',
        claim_type: 'definitional',
        verdict: offline ? 'unverifiable' : 'misleading',
        confidence: 0.61,
        explanation: 'The definition is stated with the distributions the other way round from the usual convention.',
        citations: offline ? [] : [
          { source_id: 's3', title: 'Elements of Information Theory', quoted_span: 'H(p,q) = -sum p log q',
            stance: 'refutes', source_tier: 'peer_reviewed', quote_exact: true },
        ],
        start_ms: at(6).start_ms ?? 182240,
        start_time_text: at(6).start_time_text ?? '3:02',
        searches_used: offline ? 0 : 2,
        adjustments: ['confidence reduced: single source'],
      },
      {
        // No start_ms — the quote could not be located. Must still be usable.
        quote: 'a claim whose quote was not found in the transcript',
        claim: 'Distillation always produces a smaller model than its teacher.',
        claim_type: 'factual',
        verdict: 'needs_context',
        confidence: 0.44,
        explanation: 'True for typical setups but not required by the method itself.',
        citations: [
          { source_id: 's4', url: 'https://example.org/distill', title: 'Distilling the Knowledge in a Neural Network',
            quoted_span: 'the distilled model need not be smaller', stance: 'context',
            source_tier: 'preprint', quote_exact: true, year: '2015', peer_reviewed: false },
          { source_id: 's5', title: 'Internal notes on distillation', quoted_span: 'teacher and student may share a size',
            stance: 'context', source_tier: 'private_corpus', quote_exact: true },
        ],
        searches_used: 1,
        adjustments: [],
      },
      {
        quote: 'this is the best video on the topic',
        claim: 'This is the best explanation of cross-entropy available.',
        claim_type: 'opinion',
        verdict: 'opinion',
        confidence: 0.9,
        explanation: 'A value judgement, not a checkable claim.',
        citations: [],
        start_ms: at(3).start_ms ?? 94520,
        start_time_text: at(3).start_time_text ?? '1:34',
        searches_used: 0,
        adjustments: [],
      },
    ];

    return send(200, strip({
      language: 'en',
      summary: 'Most of the video checks out. One definition is stated backwards, and one claim needs context.',
      claims,
      skipped: [{ quote: 'and so on', claim: 'trailing filler', type: 'non-claim', reason: 'not a factual assertion' }],
      searches_used: offline ? 0 : 6,
      duration_ms: DELAY,
      model: 'mock-model-1',
      research_enabled: !offline,
      warnings: [
        ...(offline ? ['offline mode: no sources were retrieved, so no claim can be confirmed and all verdicts are unverifiable'] : []),
        ...(cues.reduce((n, c) => n + (c.snippet || '').length, 0) > 24000
          ? ['transcript was truncated; only the opening portion was checked'] : []),
      ],
    }));
  }

  send(404, { detail: 'not found' });
});

server.listen(Number(process.env.MOCK_PORT || 8000), () =>
  console.log('mock backend on', server.address().port, '| mode:', MODE, '| key:', KEY ? 'required' : 'open'));
