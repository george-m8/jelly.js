(function (global) {

  // ─── Effect pool ───────────────────────────────────────────────────────────
  //
  // Each effect is an object:
  //   { name: string, duration: ms, apply: fn(el), remove: fn(el) }
  //
  // apply() and remove() do whatever you want — add a class, set inline style,
  // anything. The library handles the timing and active-char guard.
  //
  // Edit, add, or remove effects here. To change just one effect at runtime:
  //   textEffects.addEffect({ name: 'weight', duration: 200, apply: ..., remove: ... })
  // To kill an effect entirely:
  //   textEffects.removeEffect('blur')

  var DEFAULT_EFFECTS = [
    {
      name: 'weight',
      duration: 300,
      apply:  function(el) { el.classList.add('char-weight'); },
      remove: function(el) { el.classList.remove('char-weight'); },
    },
    {
      name: 'drift',
      duration: 400,
      apply:  function(el) { el.classList.add('char-drift'); },
      remove: function(el) { el.classList.remove('char-drift'); },
    },
    {
      name: 'shadow',
      duration: 500,
      apply:  function(el) { el.classList.add('char-shadow'); },
      remove: function(el) { el.classList.remove('char-shadow'); },
    },
    {
      name: 'flash',
      duration: 350,
      apply: function(el) {
        var colours = [
          'var(--colour-accent,     #e81010)',
          'var(--colour-accent-alt, #ff4040)',
          'var(--colour-flash-red,  #ff3e3e)',
        ];
        el.style.color = colours[Math.floor(Math.random() * colours.length)];
      },
      remove: function(el) { el.style.color = ''; },
    },
    {
      name: 'blur',
      duration: 200,
      apply:  function(el) { el.classList.add('char-blur'); },
      remove: function(el) { el.classList.remove('char-blur'); },
    },
    {
      name: 'scale',
      duration: 250,
      apply:  function(el) { el.classList.add('char-scale'); },
      remove: function(el) { el.classList.remove('char-scale'); },
    },
  ];

  // ─── Internals ─────────────────────────────────────────────────────────────

  var effectPool = {};
  DEFAULT_EFFECTS.forEach(function(e) { effectPool[e.name] = e; });

  var allChars      = [];
  var activeChars   = new Set();
  var isListening   = false;
  var rafPending    = false;
  var idleTimer     = null;
  var observer      = null;

  function injectStyles() {
    if (document.getElementById('text-effects-css')) return;
    var s = document.createElement('style');
    s.id = 'text-effects-css';
    s.textContent = [
      '.char{display:inline-block;transition:font-weight .15s ease,transform .15s ease,text-shadow .2s ease,color .2s ease,filter .15s ease}',
      '.char-weight{font-weight:900}',
      '.char-drift{transform:translateY(-4px)}',
      '.char-shadow{text-shadow:0 0 12px var(--colour-accent,#e81010)}',
      '.char-blur{filter:blur(1.5px)}',
      '.char-scale{transform:scale(1.2)}',
    ].join('');
    document.head.appendChild(s);
  }

  function getPool(el) {
    var attr = el.dataset && el.dataset.effects;
    if (!attr) return Object.values(effectPool);
    var names = attr.split(',').map(function(s) { return s.trim(); });
    var pool = names.map(function(n) { return effectPool[n]; }).filter(Boolean);
    return pool.length ? pool : Object.values(effectPool);
  }

  function triggerEffect(el) {
    if (activeChars.has(el)) return;
    var pool = getPool(el);
    if (!pool.length) return;
    var effect = pool[Math.floor(Math.random() * pool.length)];
    activeChars.add(el);
    effect.apply(el);
    setTimeout(function() {
      effect.remove(el);
      activeChars.delete(el);
    }, effect.duration);
  }

  function triggerRandom(count, chars) {
    var src = chars || allChars;
    if (!src.length) return;
    var shuffled = src.slice().sort(function() { return Math.random() - 0.5; });
    shuffled.slice(0, count).forEach(triggerEffect);
  }

  function splitChars() {
    var reactiveEls = document.querySelectorAll('[data-reactive="true"]');
    Array.prototype.forEach.call(reactiveEls, function(el) {
      if (el.querySelector('.char')) return;
      var effectAttr = el.dataset && el.dataset.effects;
      var text = el.textContent || '';
      el.textContent = '';
      text.split('').forEach(function(char) {
        var span = document.createElement('span');
        span.className = 'char';
        span.textContent = char === ' ' ? ' ' : char;
        if (effectAttr) span.dataset.effects = effectAttr;
        el.appendChild(span);
      });
    });
    allChars = Array.prototype.slice.call(document.querySelectorAll('.char'));
  }

  function setupObserver() {
    if (observer) observer.disconnect();
    if (!('IntersectionObserver' in window)) return;
    var sections = Array.prototype.slice.call(
      document.querySelectorAll('[data-reactive="true"]')
    );
    if (!sections.length) return;
    observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var chars = Array.prototype.slice.call(
          entry.target.querySelectorAll('.char')
        );
        chars.forEach(function(char, i) {
          setTimeout(function() { triggerEffect(char); }, i * 40);
        });
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.3 });
    sections.forEach(function(el) { observer.observe(el); });
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function() {
      if (allChars.length) triggerRandom(1);
    }, 4000);
  }

  function onMouseMove(e) {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      resetIdle();
      var nearby = allChars.filter(function(el) {
        var r = el.getBoundingClientRect();
        var dx = (r.left + r.width  / 2) - e.clientX;
        var dy = (r.top  + r.height / 2) - e.clientY;
        return Math.sqrt(dx * dx + dy * dy) < 80;
      });
      if (nearby.length) triggerRandom(1 + Math.floor(Math.random() * 3), nearby);
    });
  }

  function onPointerDown(e) {
    resetIdle();
    var x = e.touches ? e.touches[0].clientX : e.clientX;
    var y = e.touches ? e.touches[0].clientY : e.clientY;
    var radius = 80 + Math.random() * 60;
    var nearby = allChars.filter(function(el) {
      var r = el.getBoundingClientRect();
      var dx = (r.left + r.width  / 2) - x;
      var dy = (r.top  + r.height / 2) - y;
      return Math.sqrt(dx * dx + dy * dy) < radius;
    });
    triggerRandom(5 + Math.floor(Math.random() * 4), nearby.length ? nearby : allChars);
  }

  function attachListeners() {
    document.addEventListener('mousemove',  onMouseMove);
    document.addEventListener('click',      onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
  }

  function detachListeners() {
    document.removeEventListener('mousemove',  onMouseMove);
    document.removeEventListener('click',      onPointerDown);
    document.removeEventListener('touchstart', onPointerDown);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * textEffects.init(options?)
   *
   * Find [data-reactive="true"] elements, split them into .char spans, attach
   * all event listeners, and start the idle nudge timer. Safe to call again
   * after a page navigation — already-split elements are skipped.
   *
   * options.selector  {string}   — override '[data-reactive="true"]' (future use)
   */
  function init(options) {
    injectStyles();
    splitChars();
    setupObserver();
    resetIdle();
    if (!isListening) {
      attachListeners();
      isListening = true;
    }
  }

  /**
   * textEffects.cleanup()
   *
   * Remove all listeners and observers. Call before tearing down the page.
   */
  function cleanup() {
    detachListeners();
    if (observer) { observer.disconnect(); observer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    isListening = false;
    allChars = [];
    activeChars.clear();
    rafPending = false;
  }

  /**
   * textEffects.addEffect(effect)
   *
   * Add or replace an effect in the pool.
   * effect: { name, duration, apply(el), remove(el) }
   *
   * Example — add a colour-invert effect:
   *   textEffects.addEffect({
   *     name: 'invert',
   *     duration: 400,
   *     apply:  el => el.style.filter = 'invert(1)',
   *     remove: el => el.style.filter = '',
   *   });
   */
  function addEffect(effect) {
    effectPool[effect.name] = effect;
  }

  /**
   * textEffects.removeEffect(name)
   *
   * Remove an effect from the pool by name.
   */
  function removeEffect(name) {
    delete effectPool[name];
  }

  /**
   * textEffects.randomise(count?, chars?)
   *
   * Manually trigger random effects. Useful for custom interactions.
   */
  function randomise(count, chars) {
    triggerRandom(count || 1, chars);
  }

  global.textEffects = {
    init:         init,
    cleanup:      cleanup,
    addEffect:    addEffect,
    removeEffect: removeEffect,
    randomise:    randomise,
    get effects() { return Object.assign({}, effectPool); },
  };

})(typeof window !== 'undefined' ? window : this);
