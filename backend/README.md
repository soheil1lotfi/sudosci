# Transcript fact-check API

Takes a video transcript, extracts the factual claims, checks each one against
sources retrieved through the alien.club research MCP, and returns a verdict per
claim with quoted citations. Works on transcripts in any language. Runs a local
Gemma 4 model on a single GPU, deployable to NVIDIA Brev.

## Read this first: what it can and cannot check

The research MCP is **not a web search engine**. Its catalogue (verified against
the live server) is scholarly and archival:

| Source | What it covers |
| --- | --- |
| OpenAIRE Graph | Publications, research datasets, projects, organisations — titles, abstracts, DOIs, journals, peer-review status, citation counts |
| BnF / Gallica | Digitised books, newspapers and periodicals from the Bibliothèque nationale de France (opt-in) |
| `datacluster_*` | Keyword and vector search over document collections uploaded to the account |

So:

- **Scientific, medical, technical, environmental and social-science claims
  verify well** — against peer-reviewed literature, with real DOIs.
- **Consumer pricing, product specs, release dates, company announcements,
  sport results and current news cannot be verified** and come back
  `unverifiable`. There is no source in the catalogue that covers them.

The Galaxy Z Fold 8 transcript in the original spec is the second kind: the
service will extract its claims correctly, classify the opinions out, and then
honestly report that the scholarly record cannot settle a phone's launch price.
That is the designed behaviour, not a failure — but if consumer-tech claims are
the actual target, this MCP is the wrong evidence base and a general web-search
tool needs adding alongside it.

No document clusters are configured on the current account, so `search_literature`
and `search_research_data` are the two tools live today. The private-corpus tool
appears automatically once clusters exist.

## How it works

```
SerpAPI transcript payload
  │
  ├─ stitch segments into one document        ingest.py
  │    ASR cuts every ~8s, mid-sentence, so claims straddle snippet
  │    boundaries; claims are located back to timestamps afterwards
  │
  ├─ decompose into atomic claims             prompts.py + pipeline.py
  │    one model call: verbatim quote, self-contained English restatement,
  │    claim type, check-worthiness, scientific flag, language
  │
  ├─ gate: skip opinions and tautologies      pipeline.py
  │    no search is spent on "it feels nice in the hand"
  │
  ├─ per claim, in parallel: search or answer  pipeline.py + research.py
  │    FIRE-style loop — each turn the model either issues a search or
  │    commits to a verdict, capped at 3 searches per claim / 24 per request
  │
  ├─ validate every citation                   citations.py
  │    source id must resolve to a retrieved document AND the quoted span
  │    must appear in it; survivors keep their tier and bibliographic detail
  │
  └─ aggregate + summarise in the source language
```

Design choices worth knowing, each from the fact-checking literature:

- **Evidence only, never plausibility.** LLMs score *worse* on factual claims
  than on opinions because they judge by tone. The verify prompt states that
  retrieved evidence is the only admissible basis, and empty retrieval means
  `unverifiable`, not a guess.
- **Citations are checked mechanically, not trusted.** Published citation
  hallucination rates run 11–57%. A `source_id` that does not resolve, or a
  quoted span absent from its document, is discarded — and a verdict that loses
  all its evidence is **downgraded to `unverifiable`**, with the override
  reported in `adjustments`. This is the guarantee the response format rests on.
- **Few verdict labels.** Inter-model agreement collapses on fine-grained middle
  categories, so there are six, with `unverifiable` always available as
  abstention.
- **English pivot, source-language answer.** Cross-lingual retrieval works best
  with English queries; explanations come back in the speaker's language.
- **Source tiers.** Systematic reviews and meta-analyses rank above primary
  research, above preprints (labelled as not peer-reviewed), and citations sort
  strongest-first — assigned from real OpenAIRE metadata, not URL guesswork.
- **Confidence is bounded by evidence.** A single source caps confidence at 0.8;
  `unverifiable` caps at 0.4.

## Model and GPU

**`google/gemma-4-12B-it`, dense, BF16, on vLLM.**

| Variant | BF16 VRAM | Verdict |
| --- | --- | --- |
| Gemma 4 E4B | 15.2 GB | Too weak for scientific reasoning |
| **Gemma 4 12B dense** | **22.8 GB** | **Chosen** — 256K context, 140+ languages, ~77% MMLU-Pro |
| Gemma 4 26B-A4B (MoE) | ~48–52 GB | Needs 80 GB: all 128 experts stay resident. 4-bit hurts it badly |
| Gemma 4 31B dense | ~59 GB | Needs two GPUs |

12B scores within a point or two of the 26B MoE on MMLU-Pro and GPQA while
leaving ~20 GB for KV cache at 32K context with real concurrency.

**GPU: L40S 44 GB.** Brev does not offer an A100-40GB SKU at all — the ~40 GB
options are L40S 44 GB, L40 48 GB, RTX 6000 Ada 48 GB and A6000 48 GB. L40S is
the right pick anyway: it is Ada, so FP8 is available if more headroom is wanted
later, whereas A100 is Ampere and limited to INT4.

**Latency note.** Gemma 4's heterogeneous attention heads push vLLM onto Triton
kernels instead of FlashAttention, which leaves TTFT good but end-to-end latency
poor. Multi-Token Prediction speculative decoding recovers 1.5–3× of that, so
the `--speculative-config` flag in `docker-compose.yml` is load-bearing, not a
micro-optimisation. Prefix caching also matters here: every claim shares a long
system prompt.

## Deploy to Brev

1. **Get credentials.** An alien.club API key (`oat_...`) and a Hugging Face
   token that has accepted the Gemma licence.
2. **Create a Launchable** — Docker Compose mode, pointed at this repo's
   `backend/docker-compose.yml` Git URL. Pick an **L40S 44 GB** or larger. Set
   **JupyterLab = No**: the API serves its own port.
3. **Set launch environment variables:**
   ```
   HF_TOKEN=hf_...
   MCP_API_KEY=oat_...
   API_KEY=<a bearer token you invent, to protect the endpoint>
   ```
4. **Reach the API.** `brev port-forward <instance> --port 8080:8080`. Use this
   rather than the console Tunnel for programmatic access — tunnel URLs sit
   behind a Cloudflare browser-auth redirect, so scripts get an HTML login page
   instead of JSON.
5. **Verify:** `curl localhost:8080/ready` should report the model loaded and
   the research tools resolved.

First boot downloads ~23 GB of weights, so allow ~10 minutes.

Brev specifics that will bite otherwise:

- **Only `/home/ubuntu/workspace` survives a stop/start.** The compose file
  mounts the Hugging Face cache there; without it every restart re-downloads the
  weights.
- **No documented idle auto-stop.** You are billed while idle — stop the
  instance manually. Some instance types cannot stop, only delete: check the
  `FEATURES` column.
- **A stopped instance's data is inaccessible until GPU capacity returns in that
  region.** Push to Git before stopping.

## Local development

```bash
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # add MCP_API_KEY
pytest                        # 66 tests, no GPU or network needed
```

Verify the research path against the live MCP without a GPU:

```bash
MCP_API_KEY=oat_... PYTHONPATH=. python scripts/check_mcp.py "MMR vaccine autism meta-analysis"
```

This confirms credentials, lists the resolved tools, runs a real search, and
proves the citation validator accepts a genuine quote while rejecting both an
invented source id and a fabricated span.

To run the API against a model, bring up the whole stack with
`docker compose up` (needs a GPU), or point `LLM_BASE_URL` at any
OpenAI-compatible endpoint.

## API

### `POST /v1/factcheck`

Accepts a SerpAPI `youtube_video_transcript` response verbatim, a bare
`transcript` segment list, or `{"text": "..."}`.

```jsonc
{
  "transcript": [ { "start_ms": 0, "snippet": "...", "start_time_text": "0:00" } ],
  "response_language": "fr",   // optional; default matches the transcript
  "offline": false             // optional; skip retrieval entirely
}
```

Response:

```jsonc
{
  "language": "en",
  "summary": "Two-sentence summary in the transcript's language.",
  "claims": [
    {
      "quote": "vaccines cause autism in children",
      "claim": "The MMR vaccine causes autism in children.",
      "claim_type": "factual",
      "verdict": "false",
      "confidence": 0.8,
      "explanation": "Large meta-analyses find no association.",
      "start_ms": 0,
      "start_time_text": "0:00",
      "searches_used": 1,
      "citations": [
        {
          "source_id": "S1",
          "title": "Vaccines are not associated with autism: An evidence-based meta-analysis...",
          "url": "https://doi.org/10.1016/j.vaccine.2014.04.085",
          "doi": "10.1016/j.vaccine.2014.04.085",
          "venue": "Vaccine",
          "year": "2014",
          "citation_count": 428,
          "peer_reviewed": true,
          "source_tier": "systematic_review",
          "quoted_span": "Vaccines are not associated with autism: An evidence-based meta-analysis...",
          "stance": "refutes",
          "quote_exact": true
        }
      ],
      "adjustments": ["confidence capped at 0.8: only one corroborating source"]
    }
  ],
  "skipped": [{ "quote": "it feels nice in the hand", "type": "opinion", "reason": "..." }],
  "searches_used": 1,
  "duration_ms": 4820,
  "research_enabled": true,
  "warnings": []
}
```

`verdict` is one of `supported`, `false`, `misleading`, `needs_context`,
`unverifiable`, `opinion`. `adjustments` records every case where validation
overrode the model — read it, it is where suppressed hallucinations show up.

Other endpoints: `GET /health` (liveness), `GET /ready` (model + research
status), `GET /v1/research/tools` (which tools resolved, and what they map onto).

Set `API_KEY` to require `Authorization: Bearer <key>` on `/v1/*`.

## Configuration

See `.env.example`. The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_API_KEY` | — | alien.club `oat_...` key. Without it every verdict is `unverifiable` |
| `LLM_MODEL` | `google/gemma-4-12B-it` | |
| `MAX_SEARCHES_PER_CLAIM` | 3 | |
| `MAX_SEARCHES_PER_REQUEST` | 24 | Total across all claims |
| `CLAIM_CONCURRENCY` | 4 | Claims verified in parallel |
| `MAX_CLAIMS` | 12 | Per transcript |
| `MCP_ENABLE_ARCHIVE` | false | Offer BnF/Gallica search too |
| `API_KEY` | — | Blank disables auth; set it in any deployment |

`scripts/mcp_login.py` exists as a fallback if only OAuth is available: it does a
one-time browser consent and prints a refresh token the service can rotate
non-interactively. With `MCP_API_KEY` set you do not need it.

## Known limitations

- **No general web search**, as above. This is the main constraint on coverage.
- Some OpenAIRE abstracts arrive with upstream encoding damage (U+FFFD
  replacement characters, mostly in non-English records). Quote matching is
  unaffected since both sides carry the same characters, but such citations read
  poorly. The text is left untouched rather than "repaired", because stripping
  non-ASCII would corrupt legitimate Chinese, Arabic and Cyrillic abstracts.
- Verdict quality on `misleading` and `needs_context` is the weakest part of any
  system like this; the prompt demands the model name the specific distortion,
  which helps but does not eliminate disagreement.
- The model has not been evaluated end-to-end here — there is no GPU in the
  development environment, so the model-dependent behaviour (decomposition
  quality, verdict accuracy) is unmeasured. The plumbing, the budgets and the
  citation guarantees are all tested; the model's judgement is not.
