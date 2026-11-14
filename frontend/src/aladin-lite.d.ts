// Hand-written types for the parts of Aladin Lite 3.9 we use (the package ships none).
declare module 'aladin-lite' {
  export type SkyCoords = [ra: number, dec: number]

  export interface HiPSEntry {
    id: string
    name: string
    url: string
  }

  export interface HiPSLayer {
    name: string
    setSliceNumber(slice: number): void
    setOpacity(opacity: number): void
  }

  export interface HiPSOptions {
    name?: string
    successCallback?: (layer: HiPSLayer) => void
    errorCallback?: (error: unknown) => void
  }

  export interface OverlayItem {
    setOverlay(overlay: GraphicOverlay): void
  }

  export interface GraphicOverlay {
    add(item: OverlayItem): void
    removeAll(): void
  }

  export interface AladinOptions {
    survey?: string | HiPSLayer
    hipsList?: HiPSEntry[]
    target?: string
    fov?: number
    realFullscreen?: boolean
    showReticle?: boolean
    showCooGridControl?: boolean
    showSimbadPointerControl?: boolean
    showSettingsControl?: boolean
    showShareControl?: boolean
    showContextMenu?: boolean
    showProjectionControl?: boolean
    showLayersControl?: boolean
    showFullscreenControl?: boolean
    showStatusBar?: boolean
  }

  export interface StackChange {
    change: 'added' | 'removed' | 'swapped'
    layer?: HiPSLayer
    overlay?: GraphicOverlay
  }

  export interface AladinInstance {
    gotoRaDec(ra: number, dec: number): void
    setFoV(fovDegrees: number): void
    setBaseImageLayer(layer: HiPSLayer | string): HiPSLayer
    getBaseImageLayer(): HiPSLayer
    addOverlay(overlay: GraphicOverlay): void
    customizeShareURLFunction(fn: () => string): void
    on(event: 'stackChanged', callback: (change: StackChange) => void): void
  }

  const A: {
    init: Promise<void>
    aladin(element: HTMLElement | string, options?: AladinOptions): AladinInstance
    imageHiPS(url: string, options?: HiPSOptions): HiPSLayer
    graphicOverlay(options?: { name?: string; color?: string; lineWidth?: number }): GraphicOverlay
    polygon(corners: SkyCoords[], options?: { color?: string; lineWidth?: number }): OverlayItem
    circle(
      ra: number,
      dec: number,
      radiusDegrees: number,
      options?: { color?: string; lineWidth?: number },
    ): OverlayItem
  }

  export default A
}
