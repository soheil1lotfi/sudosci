/* The panel that opens when a marker is clicked.
 *
 * Intentionally an empty shell for now: header (severity + timestamp) and a
 * body placeholder. The analysis view — transcript excerpt, verdict, sources —
 * drops into `.sudosci-panel-body`.
 */
(() => {
  const NS = window.__SUDOSCI;
  const { el, SEVERITY, formatTime } = NS;

  let host = null;
  let onCloseCallback = null;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;

    // Built with DOM calls rather than innerHTML: the host pages enforce
    // Trusted Types, and this sidesteps the question entirely.
    host = el('div', 'sudosci-panel-host', { 'data-sudosci': 'panel' });

    const panel = el('div', 'sudosci-panel', {
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': 'Claim analysis',
    });

    const header = el('header', 'sudosci-panel-header');
    const titles = el('div', 'sudosci-panel-titles');
    titles.append(
      el('span', 'sudosci-panel-severity'),
      el('span', 'sudosci-panel-time')
    );
    const closeButton = el('button', 'sudosci-panel-close', {
      type: 'button',
      'aria-label': 'Close',
    });
    closeButton.textContent = '×';
    header.append(el('span', 'sudosci-panel-dot'), titles, closeButton);

    const body = el('div', 'sudosci-panel-body');
    const placeholder = el('div', 'sudosci-panel-placeholder');
    const placeholderText = el('span');
    placeholderText.textContent = 'Claim analysis will appear here.';
    placeholder.appendChild(placeholderText);
    body.appendChild(placeholder);

    panel.append(header, body);
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

  function open(claim, { onClose } = {}) {
    const node = ensureHost();
    const severity = SEVERITY[claim.severity] || SEVERITY.unverified;

    node.querySelector('.sudosci-panel-dot').style.background = severity.color;
    node.querySelector('.sudosci-panel-severity').textContent = severity.label;
    node.querySelector('.sudosci-panel-time').textContent = formatTime(claim.time);
    node.classList.add('sudosci-open');

    onCloseCallback = onClose || null;
    document.addEventListener('keydown', onKeydown, true);
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
