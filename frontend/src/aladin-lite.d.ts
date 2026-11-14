declare module 'aladin-lite' {
  export interface AladinView {
    gotoRaDec(ra: number, dec: number): void
    setFoV(fovDegrees: number): void
  }

  const A: {
    init: Promise<void>
    aladin(element: HTMLElement | string, options?: Record<string, unknown>): AladinView
  }

  export default A
}
