# textEffects

Ambient character-level animation for headings and display text. Splits `[data-reactive="true"]` elements into individual character spans and triggers randomised CSS effects in response to mouse proximity, clicks, scroll entry, and idle time.

Progressive enhancement — no effect on layout, SSR, or accessibility.

## Files

| File | Purpose |
|---|---|
| `textEffects.js` | The library (self-contained, injects its own CSS) |
| `textEffects.css` | Optional external stylesheet (use if you want to customise transitions) |
| `demo/index.html` | Interactive demo |

---

## Quick start

```html
<script src="textEffects.js"></script>
<script>textEffects.init();</script>
```

Mark elements for animation:

```html
<h1 data-reactive="true">Cool Bike Club</h1>
```

That's it. The library injects its own `<style>` block, splits the heading into character spans, and attaches event listeners.

---

## Per-element effect selection

By default every reactive element draws from the full effect pool. Restrict an element to specific effects with `data-effects`:

```html
<h2 data-reactive="true" data-effects="drift,scale,weight">Upcoming Events</h2>
```

---

## API

### `textEffects.init()`

Find all `[data-reactive="true"]` elements, split chars, attach listeners, start idle timer. Safe to call again after a page navigation — already-split elements are skipped.

### `textEffects.cleanup()`

Remove all listeners and observers. Call before tearing down the page.

### `textEffects.addEffect(effect)`

Add or replace an effect. The effect object:

```js
{
  name:     'myEffect',    // string key — used in data-effects attribute
  duration: 400,           // ms before remove() is called
  apply:    el => { ... }, // what to do to the element
  remove:   el => { ... }, // how to undo it
}
```

Example — add a colour-invert effect:

```js
textEffects.addEffect({
  name: 'invert',
  duration: 400,
  apply:  el => el.style.filter = 'invert(1)',
  remove: el => el.style.filter = '',
});
```

### `textEffects.removeEffect(name)`

Remove an effect from the pool by name. Active instances run to completion.

### `textEffects.randomise(count?)`

Manually trigger `count` random effects (default 1). Useful for custom interactions.

### `textEffects.effects`

Read-only snapshot of the current effect pool as a plain object keyed by name.

---

## Built-in effects

| Name | What it does | Duration |
|---|---|---|
| `weight` | font-weight → 900 | 300ms |
| `drift` | translateY(-4px) | 400ms |
| `shadow` | text-shadow glow | 500ms |
| `flash` | random colour shift | 350ms |
| `blur` | blur(1.5px) | 200ms |
| `scale` | scale(1.2) | 250ms |

---

## CSS custom properties

The `flash` effect and `char-shadow` use CSS variables. Define these in your `:root`:

```css
:root {
  --colour-accent:     #e81010;
  --colour-accent-alt: #ff4040;
  --colour-flash-red:  #ff3e3e;
}
```

Fallback values are baked in so the library works without them.

---

## React / Next.js

For React projects use `lib/textEffects.ts` (TypeScript port) + `components/TextEffectProvider.tsx`. See the Cool Bike Club website repo for the reference implementation.
