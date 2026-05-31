# jelly

Physics-based character animation for headings and display text. Splits `[data-reactive="true"]` elements into individual character spans and runs spring physics in response to mouse proximity, clicks, and scroll velocity. Also supports per-point physics on SVG `<path>` elements.

Progressive enhancement — no effect on layout, SSR, or accessibility.

## Files

| File | Purpose |
|---|---|
| `jelly.js` | The library (UMD, self-contained, injects its own CSS) |
| `jelly.css` | Optional external stylesheet (use if you want to control `.jelly-char` styles yourself) |
| `jelly.d.ts` | TypeScript declarations |
| `demo/index.html` | Interactive demo |

---

## Quick start

```html
<script src="jelly.js"></script>
<script>jelly.init();</script>
```

Mark elements for animation:

```html
<h1 data-reactive="true">Cool Bike Club</h1>
```

The library injects a `<style>` block, splits the text into character spans, and attaches event listeners. Safe to call again after a client-side navigation — already-split elements are re-scanned but not double-split.

---

## How it works

Three independent physics systems run in a single `requestAnimationFrame` loop:

| System | Trigger | What happens |
|---|---|---|
| **Proximity** | Mouse moves near a character | Characters are pushed away and scale down slightly, springing back when the cursor leaves |
| **Ripple** | Click or tap on a link or button | A wave radiates outward, kicking nearby characters upward with a bounce |
| **Scroll inertia** | Page scrolls | Characters lag behind scroll velocity, with more effect toward the edges of each element |

---

## Individual element targeting

Mark any element (including non-text elements) with `data-jelly` to include it directly in the physics simulation without character-splitting:

```html
<img data-jelly src="logo.png" />
```

---

## SVG path physics

Wrap an SVG in `[data-jelly-nodes]` to apply per-point physics to its `<path>` elements. Each terminal point on the path is treated as an individual physics node — the cursor repels path points directly, deforming the shape.

```html
<svg data-jelly-nodes viewBox="0 0 100 100">
  <path d="M10 50 C 10 10, 90 10, 90 50" />
</svg>
```

Non-path child elements (`<circle>`, `<rect>`, etc.) inside `[data-jelly-nodes]` receive element-level proximity physics instead.

---

## API

### `jelly.init(options?)`

Find all `[data-reactive="true"]` elements (and any `[data-jelly]` / `[data-jelly-nodes]` elements), split text into character spans, attach event listeners, and start the animation loop.

Calling `init()` a second time (e.g. after a navigation) performs a rescan — new elements are picked up without duplicating listeners.

```js
jelly.init({
  selector: '[data-reactive="true"]', // CSS selector for text elements to split
  proximity: { radius: 150 },         // override proximity defaults
  ripple:    { waveSpeed: 1.0 },      // override ripple defaults
  inertia:   { strength: 0.30 },      // override inertia defaults
});
```

### `jelly.cleanup()`

Cancel the animation loop, remove all event listeners, and restore any deformed SVG paths to their original `d` attribute. Call before tearing down the page.

### `jelly.configure(options)`

Update physics parameters at runtime without restarting. Does not accept `selector`.

```js
jelly.configure({
  proximity: { pushStrength: 35, radius: 200 },
  ripple:    { liftStrength: 24 },
});
```

---

## Configuration reference

All values are optional. Defaults shown below.

### `proximity`

Controls the mouse-repulsion spring.

| Option | Default | Description |
|---|---|---|
| `radius` | `150` | Mouse influence radius in px |
| `pushStrength` | `20` | Max displacement (px) at the cursor centre |
| `scaleRange` | `0.18` | How much characters shrink at the cursor centre (fraction of normal size) |
| `stiffness` | `0.10` | Spring stiffness — higher = snappier return |
| `damping` | `0.72` | Velocity damping — lower = more oscillation |

### `ripple`

Controls the click/tap wave.

| Option | Default | Description |
|---|---|---|
| `waveSpeed` | `1.0` | Wave expansion speed in px/ms |
| `maxRadius` | `400` | Characters beyond this distance are unaffected |
| `liftStrength` | `16` | Peak upward velocity kick (px/frame) |
| `stiffness` | `0.05` | Spring pulling characters back to rest |
| `damping` | `0.80` | Damping on the return spring |

### `inertia`

Controls the scroll-lag effect.

| Option | Default | Description |
|---|---|---|
| `strength` | `0.30` | Scroll-velocity multiplier |
| `maxOffset` | `25` | Maximum displacement cap in px |
| `decay` | `0.86` | Per-frame decay factor — higher = slower decay |

---

## React / Next.js

For React projects, wrap your layout with a provider that calls `jelly.init()` after mount and `jelly.cleanup()` before unmount. See `components/TextEffectProvider.tsx` in the Cool Bike Club website repo for the reference implementation.
