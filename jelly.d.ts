interface ProximityOptions {
  radius?:       number
  pushStrength?: number
  scaleRange?:   number
  stiffness?:    number
  damping?:      number
}

interface RippleOptions {
  waveSpeed?:    number
  maxRadius?:    number
  liftStrength?: number
  stiffness?:    number
  damping?:      number
}

interface InertiaOptions {
  strength?:  number
  maxOffset?: number
  decay?:     number
}

interface JellyOptions {
  selector?:  string
  proximity?: ProximityOptions
  ripple?:    RippleOptions
  inertia?:   InertiaOptions
}

interface Jelly {
  init(options?: JellyOptions): void
  cleanup(): void
  configure(options: Omit<JellyOptions, 'selector'>): void
}

declare const jelly: Jelly
export = jelly
