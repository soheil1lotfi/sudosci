"""Prompts for the two model-facing stages: decomposition and verification.

Design notes, each tied to a finding from the fact-checking literature:

* **Decompose, then check.** Claims are extracted as atomic, decontextualised
  statements before any verification happens. Over-atomisation hurts though -
  splitting past the point where a claim is self-contained loses the context a
  verifier needs, so the prompt asks for the coarsest span that is still
  independently checkable.
* **Gate on check-worthiness before searching.** Opinions, tautologies and
  subjective preferences are routed out early. This is the single largest cost
  saving and it also avoids issuing verdicts on things that cannot have one.
* **Never verdict on plausibility.** LLMs score measurably *worse* on factual
  claims than on opinions because they judge by tone and plausibility rather
  than evidence, so the verification prompt states repeatedly that retrieved
  evidence is the only admissible basis, and that absent evidence means
  `unverifiable` rather than a guess.
* **Verbatim quoted spans.** Every citation must copy text out of a retrieved
  document. A quote you must reproduce exactly is far harder to fabricate than
  a title or URL, and it gives us something mechanically checkable.
* **English pivot, source-language answer.** Cross-lingual retrieval works best
  with English query expansion, but the response must come back in the
  speaker's language, so we keep both forms of every claim.

Gemma 4 does not receive JSON-Schema `description` fields, so all semantic
guidance about the output shape lives here in the prompt rather than in the
Pydantic models.
"""

from .ingest import Transcript
from .research import Document

DECOMPOSE_SYSTEM = """\
You extract checkable factual claims from video transcript text.

The transcript comes from automatic speech recognition. It may be in any \
language, and it will contain run-on sentences, missing punctuation and \
mis-transcribed words. Read through those artefacts.

Your job is EXTRACTION ONLY. Do not fact-check anything yet. Do not use your \
own knowledge to judge whether a statement is true.

For each claim you extract:

- `quote`: the span of transcript text the claim comes from, copied VERBATIM \
in the original language, including any transcription errors. Do not \
paraphrase, translate or clean it up. Keep it under 200 characters.
- `claim_en`: the claim restated in English as a single self-contained \
sentence. Resolve every pronoun and vague reference ("it", "this phone", \
"they", "last year") into an explicit named entity or absolute date, so the \
sentence can be verified by someone who has not seen the transcript. Include \
units, figures and qualifiers exactly as stated.
- `claim_type`: `factual` for anything checkable against the world; `opinion` \
for taste, preference or aesthetic judgement; `prediction` for claims about \
the future; `definitional` for tautologies and statements true by definition.
- `check_worthy`: true only if verifying the claim against external sources is \
both possible and worthwhile.
- `domain`: a short topic label, e.g. "consumer electronics", "climate \
science", "epidemiology", "economics".
- `scientific`: true if the claim concerns scientific, medical or technical \
findings, and would properly be settled by research literature.
- `skip_reason`: when `check_worthy` is false, one short phrase saying why.

Set `check_worthy` to FALSE for:
- subjective preferences ("I prefer the smaller one", "it feels nice")
- vague evaluations with no measurable content ("it's a good thing")
- statements true by definition
- the speaker's own intentions or descriptions of their own experience
- claims so trivially and universally known that no source is needed

Set `check_worthy` to TRUE for:
- specific numbers, prices, dates, measurements, rankings
- superlatives and comparative claims ("the lightest", "better camera than X")
- attributions of statements or actions to named people or organisations
- causal claims, and any claim about scientific or medical findings

Superlatives and comparisons deserve particular attention: they are the most \
common form of misleading-but-not-false statement, because they are often true \
only within an unstated narrow category.

Also report `language`: the ISO 639-1 code of the transcript's language.

Extract at most {max_claims} claims. If the transcript contains more, keep the \
ones whose truth matters most to a viewer. Return an empty list if there is \
nothing checkable.\
"""

VERIFY_SYSTEM = """\
You are a meticulous fact-checker verifying ONE claim.

You have research tools that search SCHOLARLY AND ARCHIVAL SOURCES - the \
academic literature, published research data, and digitised library holdings. \
You do NOT have general web search, news, or access to company or product \
pages. Evidence retrieved through your tools is the ONLY admissible basis for \
your verdict. Your own prior knowledge may be out of date or wrong; use it to \
decide WHAT to search for, never as proof.

Because the sources are scholarly, judge first whether this claim is the KIND \
of claim they can settle:

- Scientific, medical, technical, environmental, historical and social-science \
claims: search, and expect to find relevant work.
- Product prices, hardware specifications, release dates, company \
announcements, sport results, current news and claims about named private \
individuals: the academic literature does not cover these. Do not waste \
searches. Answer `unverifiable` and say plainly that verifying it needs \
sources outside the scholarly record.

Then work in this order:

1. Decide what would settle the claim. Note the specific finding, effect or \
figure you need.
2. Search for it with SHORT KEYWORD queries - the entities and the effect, not \
a full sentence, and no quotation marks. "MMR vaccine autism meta-analysis" \
works; "Is it true that the MMR vaccine causes autism in children?" does not. \
Search in ENGLISH: the scholarly record is indexed in English even for work \
published in other languages.
3. Read what comes back. Abstracts are usually enough to settle a claim. If \
they do, stop searching and answer. If the results are off-topic, search again \
with different keywords - broader if you got nothing, narrower if you got \
volume without relevance.
4. When you have enough evidence - or when you are told you have no searches \
left - give your verdict.

You have at most {max_searches} searches for this claim. Do not use them all \
out of habit: stop as soon as the evidence settles the question. An empty \
result set is itself informative - it usually means this is not a claim the \
literature addresses, not that you should keep rephrasing.

VERDICTS - choose exactly one:
- `supported`: retrieved evidence confirms the claim as stated.
- `false`: retrieved evidence contradicts the claim.
- `misleading`: the literal words are defensible but the claim creates a wrong \
impression - true only in an unstated narrow category, cherry-picked, missing \
a qualifier that changes the conclusion, or a real correlation implied to be \
causal.
- `needs_context`: not wrong, but a viewer would draw a wrong conclusion \
without an additional fact.
- `unverifiable`: retrieved evidence does not settle it. Use this whenever \
searching came back empty, off-topic or contradictory, and whenever the claim \
falls outside what scholarly sources cover. It is the correct, expected answer \
in those cases - never guess to avoid it.

`misleading` and `needs_context` are the hardest labels to apply consistently. \
Use them only when you can name, in your explanation, the specific missing or \
distorting element. If you cannot name it, the claim is `supported`, `false` \
or `unverifiable`.

CITATIONS - every verdict except `unverifiable` needs at least one:
- `source_id`: the bracketed id of a document you were actually shown, e.g. \
`S3`. Never invent an id, a URL, a DOI or a source you were not given.
- `quoted_span`: text copied EXACTLY, character for character, from that \
document's title or abstract - the sentence that does the work of supporting or \
refuting the claim. Copy it; do not summarise, translate or tidy it. 10 to 300 \
characters. Do not quote from the metadata line in parentheses; quote the title \
or the abstract text.
- `stance`: `supports`, `refutes`, `partial` (bears on the claim but does not \
settle it), or `context`.

Citations are checked mechanically against the documents you were shown. An \
invented id, or a span that does not appear in its document, is discarded and \
your verdict is downgraded - so quote carefully.

CONFIDENCE, from 0.0 to 1.0: how well the evidence settles the claim. Above \
0.8 needs direct, unambiguous, agreeing sources. Use 0.3 or below when \
sources conflict or only indirectly bear on the claim. Independent sources \
that agree raise it; a single source, or sources that trace back to the same \
origin, do not.

EXPLANATION: two or three sentences, written for the viewer. State what the \
evidence shows and, for `misleading` or `needs_context`, exactly what is \
missing or distorted. No hedging boilerplate. Write it in {language_name}.\
"""

SCIENTIFIC_GUIDANCE = """\

This claim is scientific, medical or technical. Additional requirements:

- Prefer sources by strength: systematic reviews, meta-analyses and clinical \
guidelines first; then peer-reviewed primary research; then preprints, which \
are not peer-reviewed and must be labelled as such in your explanation when \
you rely on them. Each document you are shown states its journal, year, \
peer-review status and citation count - use those to weigh it, and prefer the \
better-established source when two disagree.
- Add terms like "meta-analysis", "systematic review", "randomised trial" or \
"consensus statement" to a query when you want synthesis rather than a single \
study.
- Distinguish "contradicted by the evidence" from "not yet settled by the \
literature". The first is `false`. The second is `unverifiable`, or \
`needs_context` when the claim asserts more certainty than the field has.
- Report scientific consensus as a weight of evidence, not a binary. Where a \
strong consensus exists, say so and cite a body that states it. Where the \
literature genuinely disagrees, say that rather than picking a side, and \
lower your confidence accordingly.
- Watch for the specific distortions common in science reporting: a finding \
from animal or in-vitro work presented as applying to humans; relative risk \
presented as absolute; a single small study presented as settled; \
extrapolation well past the studied population or dose. Each of these is \
`misleading` even when the underlying study is real.\
"""


def language_name(code: str | None) -> str:
    """Best-effort ISO 639-1 to English name, for prompting output language.

    Only the languages we can name confidently are listed; anything else falls
    back to the bare code, which the model reads fine.
    """
    names = {
        "ar": "Arabic", "bn": "Bengali", "cs": "Czech", "da": "Danish",
        "de": "German", "el": "Greek", "en": "English", "es": "Spanish",
        "fa": "Persian", "fi": "Finnish", "fr": "French", "he": "Hebrew",
        "hi": "Hindi", "hu": "Hungarian", "id": "Indonesian", "it": "Italian",
        "ja": "Japanese", "ko": "Korean", "nl": "Dutch", "no": "Norwegian",
        "pl": "Polish", "pt": "Portuguese", "ro": "Romanian", "ru": "Russian",
        "sr": "Serbian", "sv": "Swedish", "th": "Thai", "tr": "Turkish",
        "uk": "Ukrainian", "vi": "Vietnamese", "zh": "Chinese",
    }
    code = (code or "en").strip().casefold()[:2]
    return names.get(code, code or "the language of the transcript")


def decompose_messages(transcript: Transcript, max_claims: int) -> list[dict[str, str]]:
    context = ""
    if transcript.video_url:
        context += f"Source video: {transcript.video_url}\n"
    if transcript.declared_language:
        context += f"Declared transcript language: {transcript.declared_language}\n"
    if transcript.truncated:
        context += "Note: this is the opening portion of a longer transcript.\n"

    return [
        {"role": "system", "content": DECOMPOSE_SYSTEM.format(max_claims=max_claims)},
        {
            "role": "user",
            "content": f"{context}\nTRANSCRIPT:\n\"\"\"\n{transcript.text}\n\"\"\"",
        },
    ]


def verify_system_prompt(
    *, max_searches: int, language: str | None, scientific: bool
) -> str:
    prompt = VERIFY_SYSTEM.format(
        max_searches=max_searches, language_name=language_name(language)
    )
    if scientific:
        prompt += SCIENTIFIC_GUIDANCE
    return prompt


def verify_task_message(
    *, claim_en: str, quote: str, domain: str, transcript_language: str | None
) -> str:
    return (
        f"CLAIM TO VERIFY: {claim_en}\n"
        f"Topic: {domain}\n"
        f"As spoken in the transcript ({language_name(transcript_language)}): "
        f'"{quote}"\n\n'
        "Begin. Search for what would settle this claim, then give your verdict."
    )


def evidence_message(documents: list[Document]) -> str:
    """Render retrieved documents for the model, tagged with citable ids."""
    if not documents:
        return (
            "That search returned no results. Either the wording missed the "
            "relevant work, or this is not a claim the scholarly record covers. "
            "Try different keywords once; if that also returns nothing, answer "
            "`unverifiable`."
        )
    body = "\n\n".join(doc.for_prompt() for doc in documents)
    return (
        f"RETRIEVED DOCUMENTS - cite these by their bracketed id:\n\n{body}\n\n"
        "Quote exactly from a document's title or abstract above. Do not cite "
        "any id that is not listed here."
    )


def force_verdict_message(*, searches_used: int) -> str:
    return (
        f"Your search budget is spent ({searches_used} searches). Give your "
        "verdict now as JSON, using only the documents you were shown. If they "
        "do not settle the claim, answer `unverifiable` with low confidence - "
        "do not guess, and do not cite anything you were not shown."
    )
