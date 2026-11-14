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

  export interface ImageLayer {
    setOpacity(opacity: number): void
  }

  export interface ImageOptions {
    imgFormat: 'png' | 'jpeg' | 'fits'
    name?: string
    wcs?: Record<string, number | string>
    successCallback?: (ra: number, dec: number, fov: number, layer: ImageLayer) => void
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

  export interface Catalog {
    addSources(sources: unknown[]): void
    getSources(): unknown[]
    clear(): void
  }

  export interface CatalogOptions {
    name: string
    shape: 'circle' | 'square' | 'triangle' | 'rhomb'
    color: string
    sourceSize: number
    limit: number
    onClick: 'showTable'
  }

  export interface AladinInstance {
    getRaDec(): SkyCoords
    getFov(): [number, number]
    addCatalog(catalog: Catalog): void
    removeOverlay(overlay: Catalog): void
    on(event: 'positionChanged' | 'zoomChanged', callback: () => void): void
    gotoRaDec(ra: number, dec: number): void
    setFoV(fovDegrees: number): void
    setBaseImageLayer(layer: HiPSLayer | string): HiPSLayer
    getBaseImageLayer(): HiPSLayer
    addOverlay(overlay: GraphicOverlay): void
    setOverlayImageLayer(layer: ImageLayer, name: string): ImageLayer
    getOverlayImageLayer(name: string): ImageLayer | undefined
    removeImageLayer(name: string): void
    customizeShareURLFunction(fn: () => string): void
    on(event: 'stackChanged', callback: (change: StackChange) => void): void
  }

  const A: {
    init: Promise<void>
    aladin(element: HTMLElement | string, options?: AladinOptions): AladinInstance
    imageHiPS(url: string, options?: HiPSOptions): HiPSLayer
    image(url: string, options: ImageOptions): ImageLayer
    graphicOverlay(options?: { name?: string; color?: string; lineWidth?: number }): GraphicOverlay
    polygon(corners: SkyCoords[], options?: { color?: string; lineWidth?: number }): OverlayItem
    circle(
      ra: number,
      dec: number,
      radiusDegrees: number,
      options?: { color?: string; lineWidth?: number },
    ): OverlayItem
    catalog(options: CatalogOptions): Catalog
    source(ra: number, dec: number, data: Record<string, string>): unknown
    catalogFromURL(
      url: string,
      options: CatalogOptions,
      onSuccess: (catalog: Catalog) => void,
      onError: () => void,
      useProxy: false,
    ): void
  }

  export default A
}
