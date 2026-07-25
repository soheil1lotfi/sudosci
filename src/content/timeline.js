/* Renders claim markers as an overlay on top of a player's native timeline. */
(() => {
  const NS = window.__SUDOSCI;
  const { el, clamp, formatTime, SEVERITY } = NS;

  const OVERLAY_CLASS = 'sudosci-overlay';

  class TimelineOverlay {
    /**
     * @param {HTMLElement} container the player's progress-bar element
     * @param {object} adapter
     * @param {object} settings
     */
    constructor(container, adapter, settings) {
      this.container = container;
      this.adapter = adapter;
      this.settings = settings;
      this.claims = [];
      this.duration = NaN;

      // Absolutely-positioned children need a positioned ancestor.
      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      this.root = el('div', OVERLAY_CLASS, { 'data-sudosci': 'overlay' });
      this.tooltip = el('div', 'sudosci-tooltip');
      this.root.appendChild(this.tooltip);
      container.appendChild(this.root);

      this.claimByMarker = new WeakMap();
      this.installInteractionGuard();
    }

    /* Players start scrubbing from capture-phase listeners on the bar and its
       ancestors, which run before anything bound to the marker itself. The only
       place early enough to intercept is document capture, so marker
       interaction is delegated from there. */
    installInteractionGuard() {
      this.onCapture = (event) => {
        const target = event.target;
        const marker =
          target instanceof Element ? target.closest('.sudosci-marker') : null;
        if (!marker || !this.root.contains(marker)) return;

        event.stopPropagation();
        event.preventDefault();

        if (event.type === 'click') {
          const claim = this.claimByMarker.get(marker);
          if (claim) this.activate(claim);
        }
      };

      this.guardedEvents = [
        'pointerdown',
        'mousedown',
        'touchstart',
        'dblclick',
        'click',
      ];
      for (const type of this.guardedEvents) {
        document.addEventListener(type, this.onCapture, true);
      }
    }

    setClaims(claims, duration) {
      this.claims = claims || [];
      this.duration = duration;
      this.render();
    }

    render() {
      // Wipe previous markers but keep the tooltip node.
      this.root
        .querySelectorAll('.sudosci-marker')
        .forEach((n) => n.remove());

      if (!Number.isFinite(this.duration) || this.duration <= 0) return;

      for (const claim of this.claims) {
        this.root.appendChild(this.buildMarker(claim));
      }
    }

    buildMarker(claim) {
      const severity = SEVERITY[claim.severity] || SEVERITY.unverified;
      const percent = clamp((claim.time / this.duration) * 100, 0, 100);

      const marker = el('button', 'sudosci-marker', {
        type: 'button',
        'data-severity': claim.severity,
        'aria-label': `${severity.label} claim at ${formatTime(claim.time)}: ${claim.label}`,
      });
      marker.style.left = `${percent}%`;
      marker.style.setProperty('--sudosci-color', severity.color);
      marker.appendChild(el('span', 'sudosci-marker-pin'));
      this.claimByMarker.set(marker, claim);

      // Clicks are handled by the capture guard; keyboard activation is not
      // pointer-driven, so it is bound here.
      marker.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          this.activate(claim);
        }
      });

      marker.addEventListener('pointerenter', () => {
        this.showTooltip(claim, percent, severity);
      });
      marker.addEventListener('pointerleave', () => this.hideTooltip());

      return marker;
    }

    showTooltip(claim, percent, severity) {
      this.tooltip.replaceChildren();
      const head = el('span', 'sudosci-tooltip-head');
      head.textContent = `${severity.label} · ${formatTime(claim.time)}`;
      head.style.color = severity.color;
      const body = el('span', 'sudosci-tooltip-body');
      body.textContent = claim.label;
      this.tooltip.append(head, body);
      this.tooltip.style.left = `${percent}%`;
      this.tooltip.classList.add('sudosci-visible');
    }

    hideTooltip() {
      this.tooltip.classList.remove('sudosci-visible');
    }

    activate(claim) {
      this.hideTooltip();
      if (this.settings.pauseOnClick) this.adapter.pause();
      if (this.settings.seekOnClick) {
        // Land slightly before the claim so its lead-in is audible on resume.
        this.adapter.seek(Math.max(0, claim.time - 1.5));
      }
      NS.panel.open(claim);
    }

    isAttached() {
      return document.body.contains(this.root) && document.body.contains(this.container);
    }

    destroy() {
      for (const type of this.guardedEvents) {
        document.removeEventListener(type, this.onCapture, true);
      }
      this.root.remove();
    }
  }

  NS.TimelineOverlay = TimelineOverlay;
})();
