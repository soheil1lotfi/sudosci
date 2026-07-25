"""Classify retrieved sources into evidence tiers.

A URL-based heuristic cannot judge study quality, but it reliably separates the
categories that matter most for scientific claims - a meta-analysis in a
journal versus a preprint versus a blog post - and that ordering is what lets
the response show *why* one citation carries more weight than another.
"""

import re
from urllib.parse import urlparse

from .schemas import SourceTier

_PREPRINT_HOSTS = (
    "arxiv.org", "biorxiv.org", "medrxiv.org", "chemrxiv.org", "ssrn.com",
    "osf.io", "researchsquare.com", "preprints.org", "psyarxiv.com",
)

_REVIEW_HOSTS = (
    "cochranelibrary.com", "cochrane.org", "ahrq.gov", "nice.org.uk",
    "guidelines.gov", "uspreventiveservicestaskforce.org", "ipcc.ch",
)

_PEER_REVIEWED_HOSTS = (
    "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "doi.org", "nature.com",
    "science.org", "sciencedirect.com", "springer.com", "link.springer.com",
    "wiley.com", "onlinelibrary.wiley.com", "tandfonline.com", "sagepub.com",
    "cell.com", "thelancet.com", "nejm.org", "bmj.com", "jamanetwork.com",
    "plos.org", "journals.plos.org", "frontiersin.org", "mdpi.com",
    "pnas.org", "acs.org", "aps.org", "iop.org", "cambridge.org",
    "oup.com", "academic.oup.com", "annualreviews.org", "elifesciences.org",
    "acm.org", "ieee.org", "ieeexplore.ieee.org", "jstor.org",
)

_FACT_CHECK_HOSTS = (
    "politifact.com", "snopes.com", "factcheck.org", "fullfact.org",
    "apnews.com/hub/ap-fact-check", "reuters.com/fact-check",
    "afp.com/factcheck", "factcheck.afp.com", "healthfeedback.org",
    "sciencefeedback.co", "climatefeedback.org", "leadstories.com",
    "checkyourfact.com", "truthorfiction.com", "correctiv.org",
    "maldita.es", "newtral.es", "faktencheck.afp.com",
)

_INSTITUTIONAL_HOSTS = (
    "who.int", "cdc.gov", "nih.gov", "fda.gov", "epa.gov", "nasa.gov",
    "noaa.gov", "nsf.gov", "energy.gov", "ec.europa.eu", "europa.eu",
    "ema.europa.eu", "efsa.europa.eu", "ecdc.europa.eu", "un.org",
    "worldbank.org", "imf.org", "oecd.org", "iea.org", "eia.gov",
    "bls.gov", "census.gov", "ons.gov.uk", "nhs.uk", "gov.uk",
    "metoffice.gov.uk", "esa.int", "cern.ch", "nist.gov", "iso.org",
    "ietf.org", "w3.org", "bis.org", "eurostat.ec.europa.eu",
)

_REPUTABLE_PRESS_HOSTS = (
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "ft.com",
    "economist.com", "wsj.com", "nytimes.com", "washingtonpost.com",
    "theguardian.com", "bloomberg.com", "npr.org", "pbs.org",
    "lemonde.fr", "spiegel.de", "zeit.de", "faz.net", "elpais.com",
    "asahi.com", "nhk.or.jp", "cbc.ca", "abc.net.au", "aljazeera.com",
)

_SCIENCE_JOURNALISM_HOSTS = (
    "scientificamerican.com", "newscientist.com", "sciencenews.org",
    "quantamagazine.org", "arstechnica.com", "nature.com/news",
    "statnews.com", "undark.org", "eurekalert.org", "phys.org",
    "sciencedaily.com", "livescience.com", "spektrum.de",
)

#: Title/abstract wording that marks a paper as a review or guideline. Applied
#: only to peer-reviewed and institutional sources, so a blog post mentioning
#: "meta-analysis" is not promoted.
_REVIEW_TEXT = re.compile(
    r"\b(systematic review|meta-analys[ei]s|metaanalys[ei]s|umbrella review|"
    r"scoping review|cochrane review|clinical practice guideline|"
    r"consensus statement|position statement|evidence synthesis)\b",
    re.IGNORECASE,
)

_ACADEMIC_SUFFIXES = (".edu", ".ac.uk", ".edu.au", ".ac.jp", ".edu.cn", ".ac.in")
_GOV_SUFFIXES = (".gov", ".gov.uk", ".gov.au", ".mil", ".int")


def _host(url: str | None) -> str:
    if not url:
        return ""
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
    except ValueError:
        return ""
    return (parsed.netloc or "").casefold().removeprefix("www.")


def _matches(host: str, url: str, candidates: tuple[str, ...]) -> bool:
    lowered = (url or "").casefold()
    return any(
        host == c or host.endswith(f".{c}") or ("/" in c and c in lowered)
        for c in candidates
    )


def classify_source(url: str | None, text: str = "") -> SourceTier:
    """Assign an evidence tier from a source URL, refined by its text."""
    host = _host(url)
    if not host:
        return SourceTier.OTHER

    if _matches(host, url or "", _REVIEW_HOSTS):
        return SourceTier.SYSTEMATIC_REVIEW
    if _matches(host, url or "", _FACT_CHECK_HOSTS):
        return SourceTier.FACT_CHECK
    if _matches(host, url or "", _PREPRINT_HOSTS):
        return SourceTier.PREPRINT

    is_peer_reviewed = _matches(host, url or "", _PEER_REVIEWED_HOSTS)
    is_institutional = (
        _matches(host, url or "", _INSTITUTIONAL_HOSTS)
        or host.endswith(_GOV_SUFFIXES)
        or host.endswith(_ACADEMIC_SUFFIXES)
    )

    # A review or guideline outranks the primary literature it summarises.
    if (is_peer_reviewed or is_institutional) and _REVIEW_TEXT.search(text or ""):
        return SourceTier.SYSTEMATIC_REVIEW
    if is_peer_reviewed:
        return SourceTier.PEER_REVIEWED
    if is_institutional:
        return SourceTier.INSTITUTIONAL

    # Science desks of general outlets are checked before the outlet itself.
    if _matches(host, url or "", _SCIENCE_JOURNALISM_HOSTS):
        return SourceTier.SCIENCE_JOURNALISM
    if _matches(host, url or "", _REPUTABLE_PRESS_HOSTS):
        return SourceTier.REPUTABLE_PRESS
    return SourceTier.OTHER


#: Ordering used to sort citations strongest-first in the response.
TIER_RANK: dict[SourceTier, int] = {
    SourceTier.SYSTEMATIC_REVIEW: 0,
    SourceTier.PEER_REVIEWED: 1,
    SourceTier.FACT_CHECK: 2,
    SourceTier.INSTITUTIONAL: 3,
    SourceTier.PREPRINT: 4,
    SourceTier.REPUTABLE_PRESS: 5,
    SourceTier.SCIENCE_JOURNALISM: 6,
    SourceTier.PRIVATE_CORPUS: 7,
    SourceTier.OTHER: 8,
}
