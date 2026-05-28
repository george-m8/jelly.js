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

interface TextEffectsOptions {
  selector?:  string
  proximity?: ProximityOptions
  ripple?:    RippleOptions
  inertia?:   InertiaOptions
}

interface TextEffects {
  init(options?: TextEffectsOptions): void
  cleanup(): void
  configure(options: Omit<TextEffectsOptions, 'selector'>): void
}

declare const textEffects: TextEffects
export = textEffects
