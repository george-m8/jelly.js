(function (root, factory) {
  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = factory();
  } else {
    root.jelly = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {

  // ─── Config ────────────────────────────────────────────────────────────────

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

  let mouseX = -9999;
  let mouseY = -9999;

  let allChars   = [];
  let charStates = [];
  let charRects  = [];
  let pathGroups = [];

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
    s.textContent = [
      '.jelly-char{display:inline-block;will-change:transform}',
      '.jelly-word{white-space:nowrap}',
      // overflow:visible lets child elements and displaced path coords render outside the SVG viewBox
      '[data-jelly-nodes]{overflow:visible}',
      '[data-jelly-nodes]>*{transform-box:fill-box;transform-origin:center;will-change:transform}',
    ].join('');
    document.head.appendChild(s);
  }

  // ─── SVG element helpers ────────────────────────────────────────────────────

  const SVG_SKIP = new Set(['defs','title','desc','clippath','marker','mask','symbol','filter','style','script']);
  // path/polygon/polyline handled by per-point path physics — exclude from element-level nodes
  const PATH_PHYSICS_TAGS = new Set(['path','polygon','polyline']);

  function svgNodes(svgEl) {
    return Array.from(svgEl.children).filter(el => {
      const tag = el.tagName.toLowerCase();
      if (SVG_SKIP.has(tag) || PATH_PHYSICS_TAGS.has(tag)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
  }

  // ─── SVG path per-point physics ─────────────────────────────────────────────
  //
  // Parses SVG <path d="..."> into absolute segments, runs a spring physics node
  // on each segment's terminal point, and writes back displaced coordinates each
  // frame. Control points within the same segment follow their endpoint so
  // bezier curves deform as a unit rather than stretching.

  // Number of numeric arguments per SVG path command (one repetition unit).
  const SEG_ARGC = {M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};
  // [xi, yi] of the terminal (endpoint) within a segment's args array.
  const TERM_IDX = {M:[0,1],L:[0,1],C:[4,5],S:[2,3],Q:[2,3],T:[0,1],A:[5,6]};
  // [[xi,yi],...] of control-point pairs — they follow the terminal displacement.
  const CP_IDX   = {C:[[0,1],[2,3]],S:[[0,1]],Q:[[0,1]]};

  // Tokenize a path d string into [{cmd, args}], splitting implicit repetitions.
  function tokenizePath(d) {
    const out = [];
    const re = /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:\d*\.?\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
    let cmd = null, args = [];
    let tok;
    while ((tok = re.exec(d))) {
      if (tok[1])      { if (cmd !== null) out.push({cmd, args}); cmd = tok[1]; args = []; }
      else if (tok[2]) args.push(parseFloat(tok[2]));
    }
    if (cmd !== null) out.push({cmd, args});

    const split = [];
    for (const s of out) {
      const uc = s.cmd.toUpperCase();
      const ac = SEG_ARGC[uc] ?? 0;
      if (ac === 0) { split.push({cmd: s.cmd, args: []}); continue; }
      for (let i = 0; i < s.args.length; i += ac) {
        const c = (i > 0 && uc === 'M') ? (s.cmd === 'M' ? 'L' : 'l') : s.cmd;
        split.push({cmd: c, args: s.args.slice(i, i + ac)});
      }
    }
    return split;
  }

  // Convert tokenized path to absolute coordinates. H/V are expanded to L so
  // every terminal point is always an (x,y) pair at a known index.
  function toAbsPath(tokens) {
    let cx = 0, cy = 0, mx = 0, my = 0;
    return tokens.map(({cmd, args: a}) => {
      const uc = cmd.toUpperCase();
      const abs = [...a];
      if (cmd !== uc) {
        switch (uc) {
          case 'M': case 'L': case 'T': abs[0]+=cx; abs[1]+=cy; break;
          case 'H': abs[0]+=cx; break;
          case 'V': abs[0]+=cy; break;
          case 'C': for(let i=0;i<6;i+=2){abs[i]+=cx;abs[i+1]+=cy;} break;
          case 'S': case 'Q': for(let i=0;i<4;i+=2){abs[i]+=cx;abs[i+1]+=cy;} break;
          case 'A': abs[5]+=cx; abs[6]+=cy; break;
        }
      }
      // Expand H/V to L for uniform terminal-point handling
      let nc = uc, na = abs;
      if (uc === 'H') { nc = 'L'; na = [abs[0], cy]; }
      if (uc === 'V') { nc = 'L'; na = [cx, abs[0]]; }
      switch (nc) {
        case 'M': cx=na[0]; cy=na[1]; mx=cx; my=cy; break;
        case 'L': case 'T': cx=na[0]; cy=na[1]; break;
        case 'C': cx=na[4]; cy=na[5]; break;
        case 'S': case 'Q': cx=na[2]; cy=na[3]; break;
        case 'A': cx=na[5]; cy=na[6]; break;
        case 'Z': cx=mx; cy=my; break;
      }
      return {cmd: nc, args: na, origArgs: [...na]};
    });
  }

  // One physics node per terminal point (M, L, C, S, Q, T, A — not Z).
  function makePathPoints(segs) {
    const pts = [];
    segs.forEach((seg, i) => {
      const ti = TERM_IDX[seg.cmd];
      if (!ti) return;
      pts.push({segIdx: i, ox: seg.args[ti[0]], oy: seg.args[ti[1]],
                dx: 0, dy: 0, vx: 0, vy: 0, wasMoving: false});
    });
    return pts;
  }

  function serializePath(segs) {
    return segs.map(({cmd, args}) =>
      cmd + (args.length ? args.map(n => +n.toFixed(4)).join(' ') : '')
    ).join('');
  }

  // Collect all <path> elements inside [data-jelly-nodes] SVGs.
  function collectPathGroups() {
    const groups = [];
    document.querySelectorAll('[data-jelly-nodes] path').forEach(el => {
      const svg = el.closest('svg');
      if (!svg) return;
      const d = el.getAttribute('d');
      if (!d) return;
      const segs = toAbsPath(tokenizePath(d));
      const points = makePathPoints(segs);
      if (points.length === 0) return;
      const svgPt = svg.createSVGPoint ? svg.createSVGPoint() : null;
      groups.push({el, svg, origD: d, segs, points, svgPt, anyMoving: false});
    });
    return groups;
  }

  // ─── DOM splitting ──────────────────────────────────────────────────────────

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

  function collectJellyNodes() {
    const nodes = [];
    document.querySelectorAll('[data-jelly-nodes]').forEach(el => nodes.push(...svgNodes(el)));
    return nodes;
  }

  function splitAll() {
    clearSplits();
    document.querySelectorAll(cfg.selector).forEach(splitElement);
    allChars   = [
      ...Array.from(document.querySelectorAll('.jelly-char')),
      ...Array.from(document.querySelectorAll('[data-jelly]')),
      ...collectJellyNodes(),
    ];
    charStates = allChars.map(makeState);
    pathGroups = collectPathGroups();
    cacheRects();
  }

  function rescan() {
    mouseX = -9999;
    mouseY = -9999;

    document.querySelectorAll(cfg.selector).forEach(splitElement);

    const newChars = [
      ...Array.from(document.querySelectorAll('.jelly-char')),
      ...Array.from(document.querySelectorAll('[data-jelly]')),
      ...collectJellyNodes(),
    ];
    const stateMap = new Map();
    allChars.forEach((el, i) => stateMap.set(el, charStates[i]));

    allChars   = newChars;
    charStates = newChars.map(el => stateMap.get(el) ?? makeState());

    // Reset path d attributes before re-collecting so origD is always the
    // undeformed shape, not a frame mid-displacement.
    for (const pg of pathGroups) pg.el.setAttribute('d', pg.origD);
    pathGroups = collectPathGroups();

    cacheRects();
  }

  function cacheRects() {
    const sx = window.pageXOffset;
    const sy = window.pageYOffset;
    const elCache = new Map();

    charRects = allChars.map(el => {
      const r         = el.getBoundingClientRect();
      const isWholeEl = el.hasAttribute('data-jelly') || el.closest('[data-jelly-nodes]');
      const inertiaEl = isWholeEl ? el : el.closest('h1,h2,h3,h4,h5,h6,a');

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

    // ── Character / element physics ──────────────────────────────────────────
    for (let i = 0; i < allChars.length; i++) {
      const el    = allChars[i];
      const rect  = charRects[i];
      const state = charStates[i];

      const viewY = rect.y - sy;
      if (viewY < -300 || viewY > vh + 300) {
        if (state.iy !== 0) { state.iy *= id.decay; if (Math.abs(state.iy) < REST) state.iy = 0; }
        continue;
      }

      const dx    = (rect.x - sx) - mouseX;
      const dy    = (rect.y - sy) - mouseY;
      const dist2 = dx * dx + dy * dy;
      let tx = 0, ty = 0, ts = 1;

      if (dist2 < r2 && dist2 > 0.01) {
        const dist       = Math.sqrt(dist2);
        const t          = 1 - dist / p.radius;
        const falloff    = t * t;
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

      state.rvy = (state.rvy + (0 - state.ry) * rp.stiffness) * rp.damping;
      state.ry += state.rvy;
      if (Math.abs(state.ry) < REST && Math.abs(state.rvy) < REST) {
        state.ry = 0; state.rvy = 0;
      }

      state.iy *= id.decay;
      if (Math.abs(state.iy) < REST) state.iy = 0;

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

    // ── SVG per-point path physics ────────────────────────────────────────────
    for (const pg of pathGroups) {
      const ctm = pg.svg.getScreenCTM();
      if (!ctm || !pg.svgPt) continue;

      // Convert viewport mouse position into SVG local coordinate space.
      const inv = ctm.inverse();
      pg.svgPt.x = mouseX;
      pg.svgPt.y = mouseY;
      let local;
      try { local = pg.svgPt.matrixTransform(inv); } catch(e) { continue; }

      // Scale radius and strength from viewport px to SVG units.
      const scale       = Math.sqrt(ctm.a * ctm.a + ctm.b * ctm.b);
      const svgRadius   = p.radius / scale;
      const svgStrength = p.pushStrength / scale;
      const svgR2       = svgRadius * svgRadius;

      let dirty = false;

      for (const pt of pg.points) {
        const ddx   = pt.ox - local.x;
        const ddy   = pt.oy - local.y;
        const dist2 = ddx * ddx + ddy * ddy;
        let tx = 0, ty = 0;

        if (dist2 < svgR2 && dist2 > 0.0001) {
          const dist    = Math.sqrt(dist2);
          const t       = 1 - dist / svgRadius;
          const falloff = t * t;
          tx = (ddx / dist) * svgStrength * falloff;
          ty = (ddy / dist) * svgStrength * falloff;
        }

        pt.vx = (pt.vx + (tx - pt.dx) * p.stiffness) * p.damping;
        pt.vy = (pt.vy + (ty - pt.dy) * p.stiffness) * p.damping;
        pt.dx += pt.vx;
        pt.dy += pt.vy;

        const atRest = Math.abs(pt.dx) < 0.001 && Math.abs(pt.dy) < 0.001;
        if (!atRest || pt.wasMoving) dirty = true;
        pt.wasMoving = !atRest;
      }

      if (dirty) {
        pg.anyMoving = true;
        for (const pt of pg.points) {
          const seg = pg.segs[pt.segIdx];
          const ti  = TERM_IDX[seg.cmd];
          const cps = CP_IDX[seg.cmd] || [];
          // Shift terminal point
          seg.args[ti[0]] = pt.ox + pt.dx;
          seg.args[ti[1]] = pt.oy + pt.dy;
          // Drag control points by the same delta so the curve shape is preserved
          for (const [cxi, cyi] of cps) {
            seg.args[cxi] = seg.origArgs[cxi] + pt.dx;
            seg.args[cyi] = seg.origArgs[cyi] + pt.dy;
          }
        }
        pg.el.setAttribute('d', serializePath(pg.segs));
      } else if (pg.anyMoving) {
        // All points just came to rest — snap back to exact original d string.
        pg.el.setAttribute('d', pg.origD);
        pg.anyMoving = false;
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
    const vel = (sy - lastScrollY) / dt * 16;
    lastScrollY = sy;
    lastScrollT = now;

    const { inertia: id } = cfg;
    const rawImpulse = vel * id.strength;
    const originX = scrollOriginX ?? window.innerWidth / 2;

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
    const target = e.target?.closest('a, button, [role="button"], input[type="submit"], input[type="button"]');
    if (!target) return;
    triggerRipple(x, y);
  }

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(cacheRects, 100);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

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
    for (const pg of pathGroups) pg.el.setAttribute('d', pg.origD);
    pathGroups  = [];
    allChars    = [];
    charStates  = [];
    charRects   = [];
  }

  function configure(options) {
    if (options.proximity) Object.assign(cfg.proximity, options.proximity);
    if (options.ripple)    Object.assign(cfg.ripple,    options.ripple);
    if (options.inertia)   Object.assign(cfg.inertia,   options.inertia);
  }

  return { init, cleanup, configure };

}));
