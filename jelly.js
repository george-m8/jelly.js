(function (root, factory) {
  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = factory();
  } else {
    root.jelly = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {

  // ─── Config ────────────────────────────────────────────────────────────────
  // Override any of these via init(options) or configure(options).

  const cfg = {
    selector: '[data-reactive="true"]',

    proximity: {
      radius:       150,   // px — mouse influence radius
      pushStrength:  20,   // max px displacement at cursor centre
      scaleRange:   0.18,  // chars shrink by this fraction at cursor centre
      stiffness:    0.10,  // spring stiffness
      damping:      0.72,  // velocity damping
    },

    ripple: {
      waveSpeed:    1.0,   // px/ms — ripple expansion speed
      maxRadius:   400,    // px — ripple fades out beyond this
      liftStrength:  16,   // peak upward velocity kick (px/frame)
      stiffness:    0.05,  // spring pulling char back to rest
      damping:      0.80,  // ripple damping
    },

    inertia: {
      strength:   0.30,    // scroll-velocity multiplier
      maxOffset:   25,     // px cap
      decay:       0.86,   // per-frame decay factor
    },
  };

  // ─── State ─────────────────────────────────────────────────────────────────

  // Off-screen until first mousemove/touch, and reset on each navigation to
  // prevent stale touch position from the previous page ghosting on mobile.
  let mouseX = -9999;
  let mouseY = -9999;

  let allChars   = [];
  let charStates = [];
  let charRects  = [];

  let lastScrollY   = 0;
  let lastScrollT   = 0;
  let scrollOriginX = null;

  let rafId       = null;
  let resizeTimer = null;
  let isListening = false;

  const REST = 0.01;

  function makeState() {
    return { cx:0, cy:0, cs:1, vx:0, vy:0, vs:0, ry:0, rvy:0, iy:0, wasMoving:false };
  }

  // ─── Style injection ────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('jelly-css')) return;
    const s = document.createElement('style');
    s.id = 'jelly-css';
    s.textContent = '.jelly-char{display:inline-block;will-change:transform}.jelly-word{white-space:nowrap}';
    document.head.appendChild(s);
  }

  // ─── DOM splitting ──────────────────────────────────────────────────────────
  //
  // Uses TreeWalker to find text nodes without destroying nested structure
  // (links inside headings, <strong> inside paragraphs, etc.).

  function clearSplits() {
    document.querySelectorAll('.jelly-char').forEach(span => {
      span.replaceWith(document.createTextNode(span.textContent ?? ''));
    });
    document.querySelectorAll('.jelly-word').forEach(span => {
      const frag = document.createDocumentFragment();
      while (span.firstChild) frag.appendChild(span.firstChild);
      span.replaceWith(frag);
    });
    document.querySelectorAll(cfg.selector).forEach(el => el.normalize());
  }

  function splitElement(el) {
    if (el.querySelector('.jelly-char')) return;
    if (!(el.textContent ?? '').trim()) return;

    const textNodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.jelly-char, code, pre, script, style, svg, input, textarea, select'))
          return NodeFilter.FILTER_REJECT;
        if (!(node.textContent ?? '').trim()) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    textNodes.forEach(textNode => {
      const text = textNode.textContent ?? '';
      const frag = document.createDocumentFragment();
      let wordSpan = null;
      for (const ch of text) {
        if (/\s/.test(ch)) {
          wordSpan = null;
          frag.appendChild(document.createTextNode(ch));
        } else {
          if (!wordSpan) {
            wordSpan = document.createElement('span');
            wordSpan.className = 'jelly-word';
            frag.appendChild(wordSpan);
          }
          const span = document.createElement('span');
          span.className = 'jelly-char';
          span.textContent = ch;
          wordSpan.appendChild(span);
        }
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    });
  }

  function splitAll() {
    clearSplits();
    document.querySelectorAll(cfg.selector).forEach(splitElement);
    allChars   = Array.from(document.querySelectorAll('.jelly-char'));
    charStates = allChars.map(makeState);
    cacheRects();
  }

  // Re-scan after client-side navigation: split new elements, preserve existing
  // physics state for chars still in the DOM (e.g. persistent header/footer).
  function rescan() {
    mouseX = -9999;
    mouseY = -9999;

    document.querySelectorAll(cfg.selector).forEach(splitElement);

    const newChars = Array.from(document.querySelectorAll('.jelly-char'));
    const stateMap = new Map();
    allChars.forEach((el, i) => stateMap.set(el, charStates[i]));

    allChars   = newChars;
    charStates = newChars.map(el => stateMap.get(el) ?? makeState());
    cacheRects();
  }

  function cacheRects() {
    const sx = window.pageXOffset;
    const sy = window.pageYOffset;
    // Cache element bounding rects so getBoundingClientRect is called once per
    // heading/link element, not once per character inside it.
    const elCache = new Map();

    charRects = allChars.map(el => {
      const r         = el.getBoundingClientRect();
      const inertiaEl = el.closest('h1,h2,h3,h4,h5,h6,a');

      let elLeft  = r.left + r.width / 2 + sx;
      let elRight = elLeft;
      if (inertiaEl) {
        if (!elCache.has(inertiaEl)) elCache.set(inertiaEl, inertiaEl.getBoundingClientRect());
        const pr = elCache.get(inertiaEl);
        elLeft   = pr.left  + sx;
        elRight  = pr.right + sx;
      }

      return {
        x:       r.left + r.width  / 2 + sx,
        y:       r.top  + r.height / 2 + sy,
        h:       r.height,
        inertia: !!inertiaEl,
        elLeft,
        elRight,
      };
    });
  }

  // ─── Physics loop ───────────────────────────────────────────────────────────

  function proximityTick() {
    const { proximity: p, ripple: rp, inertia: id } = cfg;
    const r2 = p.radius * p.radius;
    const sx = window.pageXOffset;
    const sy = window.pageYOffset;
    const vh = window.innerHeight;

    for (let i = 0; i < allChars.length; i++) {
      const el    = allChars[i];
      const rect  = charRects[i];
      const state = charStates[i];

      // Viewport cull — skip chars far outside visible area, but still decay inertia
      const viewY = rect.y - sy;
      if (viewY < -300 || viewY > vh + 300) {
        if (state.iy !== 0) { state.iy *= id.decay; if (Math.abs(state.iy) < REST) state.iy = 0; }
        continue;
      }

      // ── Mouse proximity spring ────────────────────────────────────────────
      const dx    = (rect.x - sx) - mouseX;
      const dy    = (rect.y - sy) - mouseY;
      const dist2 = dx * dx + dy * dy;
      let tx = 0, ty = 0, ts = 1;

      if (dist2 < r2 && dist2 > 0.01) {
        const dist       = Math.sqrt(dist2);
        const t          = 1 - dist / p.radius;
        const falloff    = t * t;                  // quadratic: gentle at edge, strong at centre
        const sizeFactor = Math.max(0.25, Math.min(1.5, rect.h / 32));
        tx = (dx / dist) * p.pushStrength * falloff * sizeFactor;
        ty = (dy / dist) * p.pushStrength * falloff * sizeFactor;
        ts = 1 - p.scaleRange * falloff * sizeFactor;
      }

      state.vx = (state.vx + (tx - state.cx) * p.stiffness) * p.damping;
      state.vy = (state.vy + (ty - state.cy) * p.stiffness) * p.damping;
      state.vs = (state.vs + (ts - state.cs) * p.stiffness) * p.damping;
      state.cx += state.vx;
      state.cy += state.vy;
      state.cs += state.vs;

      // ── Ripple spring (returns to 0) ──────────────────────────────────────
      state.rvy = (state.rvy + (0 - state.ry) * rp.stiffness) * rp.damping;
      state.ry += state.rvy;
      if (Math.abs(state.ry) < REST && Math.abs(state.rvy) < REST) {
        state.ry = 0; state.rvy = 0;
      }

      // ── Scroll inertia (pure decay) ───────────────────────────────────────
      state.iy *= id.decay;
      if (Math.abs(state.iy) < REST) state.iy = 0;

      // ── Write transform — skip if fully at rest (avoids redundant style writes)
      const atRest = Math.abs(state.cx) < REST
                  && Math.abs(state.cy) < REST
                  && Math.abs(state.cs - 1) < REST
                  && state.ry === 0
                  && state.iy === 0;

      if (!atRest || state.wasMoving) {
        const fy = state.cy + state.ry + state.iy;
        el.style.transform = `translate(${state.cx.toFixed(2)}px,${fy.toFixed(2)}px) scale(${state.cs.toFixed(4)})`;
        state.wasMoving = !atRest;
      }
    }

    rafId = requestAnimationFrame(proximityTick);
  }

  // ─── Ripple ─────────────────────────────────────────────────────────────────

  function triggerRipple(tapX, tapY) {
    const { ripple: rp } = cfg;
    const sx = window.pageXOffset;
    const sy = window.pageYOffset;

    allChars.forEach((_, i) => {
      const rect  = charRects[i];
      const state = charStates[i];
      const dx    = (rect.x - sx) - tapX;
      const dy    = (rect.y - sy) - tapY;
      const dist  = Math.sqrt(dx * dx + dy * dy);
      if (dist > rp.maxRadius) return;
      const delay      = dist / rp.waveSpeed;
      const strength   = 1 - dist / rp.maxRadius;
      const sizeFactor = Math.max(0.25, Math.min(1.5, rect.h / 32));
      setTimeout(() => { state.rvy -= rp.liftStrength * strength * sizeFactor; }, delay);
    });
  }

  // ─── Scroll inertia ─────────────────────────────────────────────────────────

  function onScroll() {
    const now = performance.now();
    const sy  = window.pageYOffset;
    const sx  = window.pageXOffset;
    const dt  = Math.max(now - lastScrollT, 1);
    const vel = (sy - lastScrollY) / dt * 16;   // normalise to ~60fps
    lastScrollY = sy;
    lastScrollT = now;

    const { inertia: id } = cfg;
    const rawImpulse = vel * id.strength;
    // Default origin to viewport centre on first scroll (before any mouse/touch event)
    const originX = scrollOriginX ?? window.innerWidth / 2;

    // Per-element tilt: within each heading/link, the character closest to the
    // cursor gets 1% inertia and the furthest character gets 100%. The range is
    // normalised to the element's own width so a narrow link and a wide heading
    // get the same full spread.
    charStates.forEach((s, i) => {
      const rect = charRects[i];
      if (!rect.inertia) return;

      const sizeFactor = Math.max(0.25, Math.min(1.5, rect.h / 32));
      const charViewX  = rect.x      - sx;
      const elLeftV    = rect.elLeft  - sx;
      const elRightV   = rect.elRight - sx;

      const maxDist  = Math.max(Math.abs(elLeftV - originX), Math.abs(elRightV - originX));
      const charDist = Math.abs(charViewX - originX);
      const xFactor  = maxDist < 1 ? 0.01 : 0.01 + 0.99 * Math.min(1, charDist / maxDist);

      const impulse  = Math.max(-id.maxOffset, Math.min(id.maxOffset, rawImpulse * sizeFactor * xFactor));
      s.iy = Math.max(-id.maxOffset, Math.min(id.maxOffset, s.iy + impulse));
    });
  }

  // ─── Event handlers ─────────────────────────────────────────────────────────

  function onMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    scrollOriginX = e.clientX;
  }

  // On touch devices there is no persistent cursor, so proximity tracks the
  // active finger and disappears the moment it lifts.
  function onTouchMove(e) {
    mouseX = e.touches[0].clientX;
    mouseY = e.touches[0].clientY;
  }

  function onTouchEnd() {
    mouseX = -9999;
    mouseY = -9999;
  }

  function onPointerDown(e) {
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    scrollOriginX = x;
    // Ripple only fires on link/button interactions — feels more natural than
    // triggering on every tap anywhere on the page.
    const target = e.target?.closest('a, button, [role="button"], input[type="submit"], input[type="button"]');
    if (!target) return;
    triggerRipple(x, y);
  }

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(cacheRects, 100);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * textEffects.init(options?)
   *
   * Find [data-reactive="true"] elements, split into .char spans, start the
   * physics loop, and attach all event listeners. Safe to call again after a
   * client-side navigation — already-split elements are skipped.
   *
   * options.selector  {string}  — CSS selector for reactive elements
   * options.proximity {object}  — { radius, pushStrength, scaleRange, stiffness, damping }
   * options.ripple    {object}  — { waveSpeed, maxRadius, liftStrength, stiffness, damping }
   * options.inertia   {object}  — { strength, maxOffset, decay }
   */
  function init(options) {
    if (options) {
      if (options.selector)  cfg.selector = options.selector;
      if (options.proximity) Object.assign(cfg.proximity, options.proximity);
      if (options.ripple)    Object.assign(cfg.ripple,    options.ripple);
      if (options.inertia)   Object.assign(cfg.inertia,   options.inertia);
    }

    injectStyles();

    if (!isListening) {
      splitAll();
      rafId = requestAnimationFrame(proximityTick);
      document.addEventListener('mousemove',  onMouseMove,  { passive: true });
      document.addEventListener('click',      onPointerDown, { passive: true });
      document.addEventListener('touchstart', onPointerDown, { passive: true });
      document.addEventListener('touchmove',  onTouchMove,  { passive: true });
      document.addEventListener('touchend',   onTouchEnd,   { passive: true });
      window.addEventListener('scroll',       onScroll,     { passive: true });
      window.addEventListener('resize',       onResize,     { passive: true });
      isListening = true;
    } else {
      rescan();
    }
  }

  /**
   * textEffects.cleanup()
   *
   * Cancel the animation loop and remove all listeners. Call before tearing
   * down the page (or in a framework's unmount/cleanup hook).
   */
  function cleanup() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    document.removeEventListener('mousemove',  onMouseMove);
    document.removeEventListener('click',      onPointerDown);
    document.removeEventListener('touchstart', onPointerDown);
    document.removeEventListener('touchmove',  onTouchMove);
    document.removeEventListener('touchend',   onTouchEnd);
    window.removeEventListener('scroll',       onScroll);
    window.removeEventListener('resize',       onResize);
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    isListening = false;
    allChars    = [];
    charStates  = [];
    charRects   = [];
  }

  /**
   * textEffects.configure(options)
   *
   * Adjust physics parameters at runtime without re-initialising.
   *
   * Example:
   *   textEffects.configure({ proximity: { pushStrength: 40, radius: 200 } });
   */
  function configure(options) {
    if (options.proximity) Object.assign(cfg.proximity, options.proximity);
    if (options.ripple)    Object.assign(cfg.ripple,    options.ripple);
    if (options.inertia)   Object.assign(cfg.inertia,   options.inertia);
  }

  return { init, cleanup, configure };

}));
