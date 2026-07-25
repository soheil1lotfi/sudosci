/* The panel that opens when a marker is clicked.
 *
 * Renders one ClaimResult from the fact-check backend. Built with DOM calls
 * rather than innerHTML: the host page enforces Trusted Types, and every string
 * here is untrusted text from a model or a third-party source.
 */
(() => {
  const NS = window.__SUDOSCI;
  const { el, formatTime, verdictOf, STANCES, SOURCE_TIERS } = NS;

  let host = null;
  let bodyEl = null;
  let onCloseCallback = null;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;

    host = el('div', 'sudosci-panel-host', { 'data-sudosci': 'panel' });

    const panel = el('div', 'sudosci-panel', {
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': 'Claim analysis',
    });

    const header = el('header', 'sudosci-panel-header');
    const titles = el('div', 'sudosci-panel-titles');
    titles.append(
      el('span', 'sudosci-panel-verdict'),
      el('span', 'sudosci-panel-confidence'),
      el('span', 'sudosci-panel-time')
    );
    const closeButton = el('button', 'sudosci-panel-close', {
      type: 'button',
      'aria-label': 'Close',
    });
    closeButton.textContent = '×';
    header.append(el('span', 'sudosci-panel-dot'), titles, closeButton);

    bodyEl = el('div', 'sudosci-panel-body');
    panel.append(header, bodyEl);
    host.appendChild(panel);

    closeButton.addEventListener('click', close);
    host.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(host);
    return host;
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && host?.classList.contains('sudosci-open')) {
      e.stopPropagation();
      close();
    }
  }

  /**
   * @param {object} entry marker entry — { time, verdict, claim: ClaimResult }
   * @param {object} [context] { analysis } for banners that apply to the whole run
   */
  function open(entry, { onClose, analysis } = {}) {
    const node = ensureHost();
    const claim = entry.claim || {};
    const verdict = verdictOf(entry.verdict);

    node.querySelector('.sudosci-panel-dot').style.background = verdict.color;

    const verdictEl = node.querySelector('.sudosci-panel-verdict');
    verdictEl.textContent = verdict.label;
    verdictEl.style.color = verdict.color;

    const confidenceEl = node.querySelector('.sudosci-panel-confidence');
    confidenceEl.textContent = Number.isFinite(claim.confidence)
      ? `${Math.round(claim.confidence * 100)}% confidence`
      : '';

    node.querySelector('.sudosci-panel-time').textContent = formatTime(entry.time);

    renderBody(claim, analysis);
    node.classList.add('sudosci-open');
    bodyEl.scrollTop = 0;

    onCloseCallback = onClose || null;
    document.addEventListener('keydown', onKeydown, true);
  }

  function renderBody(claim, analysis) {
    bodyEl.replaceChildren();

    /* Without research, everything comes back unverifiable — say so, or the
       verdict reads as "we checked and found nothing". */
    if (analysis && analysis.researchEnabled === false) {
      bodyEl.appendChild(
        banner('Search was unavailable for this run — verdicts are unverified.')
      );
    }

    if (claim.claim) {
      bodyEl.appendChild(section('Claim', paragraph(claim.claim, 'sudosci-claim')));
    }

    if (claim.quote) {
      const quote = el('blockquote', 'sudosci-quote');
      quote.textContent = claim.quote;
      bodyEl.appendChild(section('Said in the video', quote));
    }

    if (claim.explanation) {
      bodyEl.appendChild(section('Why', paragraph(claim.explanation)));
    }

    bodyEl.appendChild(renderCitations(claim.citations || []));

    if (claim.adjustments?.length) {
      bodyEl.appendChild(renderAdjustments(claim.adjustments));
    }

    bodyEl.appendChild(renderFooter(claim));
  }

  function renderCitations(citations) {
    const wrap = el('section', 'sudosci-section');
    wrap.appendChild(heading(`Sources (${citations.length})`));

    if (!citations.length) {
      wrap.appendChild(paragraph('No sources were returned for this claim.', 'sudosci-muted'));
      return wrap;
    }

    const list = el('ol', 'sudosci-citations');
    // Already ordered strongest tier first, exact quotes before fuzzy. Do not re-sort.
    for (const citation of citations) {
      list.appendChild(renderCitation(citation));
    }
    wrap.appendChild(list);
    return wrap;
  }

  function renderCitation(citation) {
    const item = el('li', 'sudosci-citation');

    const meta = el('div', 'sudosci-citation-meta');
    const stance = STANCES[citation.stance];
    if (stance) {
      const chip = el('span', 'sudosci-chip');
      chip.textContent = stance.label;
      chip.style.color = stance.color;
      chip.style.borderColor = stance.color;
      meta.appendChild(chip);
    }
    const tier = el('span', 'sudosci-tier');
    tier.textContent = SOURCE_TIERS[citation.source_tier] || citation.source_tier || 'Source';
    meta.appendChild(tier);

    if (citation.quote_exact === false) {
      const fuzzy = el('span', 'sudosci-fuzzy', {
        title: 'The quoted text was matched approximately — treat it as weaker evidence.',
      });
      fuzzy.textContent = 'fuzzy match';
      meta.appendChild(fuzzy);
    }
    item.appendChild(meta);

    // url and title are absent (not null) when unset — response_model_exclude_none.
    const label = citation.title || citation.url || citation.source_id || 'Source';
    if (citation.url) {
      const link = el('a', 'sudosci-citation-title', {
        href: citation.url,
        target: '_blank',
        rel: 'noopener noreferrer',
      });
      link.textContent = label;
      item.appendChild(link);
    } else {
      item.appendChild(paragraph(label, 'sudosci-citation-title'));
    }

    const bibliography = renderBibliography(citation);
    if (bibliography) item.appendChild(bibliography);

    if (citation.quoted_span) {
      const span = el('p', 'sudosci-citation-quote');
      span.textContent = `“${citation.quoted_span}”`;
      item.appendChild(span);
    }

    return item;
  }

  /* Scholarly detail the backend attaches so the evidence can be judged without
     opening the link. All of it is optional and absent when unknown. */
  function renderBibliography(citation) {
    const line = el('p', 'sudosci-citation-bib');
    const parts = [];

    if (citation.venue) parts.push(citation.venue);
    if (citation.year) parts.push(String(citation.year));
    if (citation.peer_reviewed === true) parts.push('peer-reviewed');
    if (Number.isFinite(citation.citation_count)) {
      parts.push(`${citation.citation_count.toLocaleString()} citations`);
    }

    for (const [i, part] of parts.entries()) {
      const span = el('span');
      span.textContent = i === 0 ? part : ` · ${part}`;
      line.appendChild(span);
    }

    if (citation.doi) {
      const prefix = el('span');
      prefix.textContent = parts.length ? ' · ' : '';
      const doi = el('a', 'sudosci-doi', {
        href: `https://doi.org/${citation.doi}`,
        target: '_blank',
        rel: 'noopener noreferrer',
      });
      doi.textContent = `doi:${citation.doi}`;
      line.append(prefix, doi);
    }

    return line.childNodes.length ? line : null;
  }

  /* The backend's channel for "this is weaker than it looks" — worth showing,
     but folded away by default. */
  function renderAdjustments(adjustments) {
    const details = el('details', 'sudosci-adjustments');
    const summary = el('summary');
    summary.textContent = `Adjustments (${adjustments.length})`;
    details.appendChild(summary);

    const list = el('ul');
    for (const text of adjustments) {
      const item = el('li');
      item.textContent = text;
      list.appendChild(item);
    }
    details.appendChild(list);
    return details;
  }

  function renderFooter(claim) {
    const footer = el('footer', 'sudosci-panel-footer');

    if (claim.claim_type) {
      const type = el('span', 'sudosci-claim-type');
      type.textContent = claim.claim_type;
      footer.appendChild(type);
    }
    if (Number.isFinite(claim.searches_used)) {
      const searches = el('span');
      const separator = claim.claim_type ? ' · ' : '';
      searches.textContent =
        `${separator}${claim.searches_used} search${claim.searches_used === 1 ? '' : 'es'}`;
      footer.appendChild(searches);
    }
    return footer;
  }

  /* ---------- small builders ---------- */

  function section(title, content) {
    const wrap = el('section', 'sudosci-section');
    wrap.append(heading(title), content);
    return wrap;
  }

  function heading(text) {
    const node = el('h4', 'sudosci-section-title');
    node.textContent = text;
    return node;
  }

  function paragraph(text, className) {
    const node = el('p', className || 'sudosci-text');
    node.textContent = text;
    return node;
  }

  function banner(text) {
    const node = el('div', 'sudosci-banner');
    node.textContent = text;
    return node;
  }

  function close() {
    host?.classList.remove('sudosci-open');
    document.removeEventListener('keydown', onKeydown, true);
    const cb = onCloseCallback;
    onCloseCallback = null;
    cb?.();
  }

  function isOpen() {
    return !!host?.classList.contains('sudosci-open');
  }

  NS.panel = { open, close, isOpen };
})();
