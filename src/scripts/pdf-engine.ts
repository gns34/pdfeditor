import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import {
  Canvas,
  StaticCanvas,
  IText,
  Textbox,
  Rect,
  Ellipse,
  Line,
  Triangle,
  Group,
  FabricImage,
  PencilBrush,
  FabricObject,
  Point,
} from 'fabric';

// Singleton PDFium library instance (initialized once per page load)
let pdfiumLibraryInstance: Awaited<ReturnType<typeof PDFiumLibrary.init>> | null = null;

async function getPdfiumLibrary() {
  if (!pdfiumLibraryInstance) {
    // Pass the WASM binary URL so Vite/browser can fetch it from /public.
    // The pdfium.wasm file must exist at /public/pdfium.wasm.
    pdfiumLibraryInstance = await PDFiumLibrary.init({
      wasmUrl: '/pdfium.wasm',
    });
  }
  return pdfiumLibraryInstance;
}

// Configure Stripi Brand style defaults for Fabric.js interactive controls
if (typeof window !== 'undefined') {
  FabricObject.prototype.transparentCorners = false;
  FabricObject.prototype.cornerColor = '#533afd';
  FabricObject.prototype.cornerStrokeColor = '#ffffff';
  FabricObject.prototype.borderColor = '#533afd';
  FabricObject.prototype.cornerSize = 8;
  FabricObject.prototype.cornerStyle = 'circle';
  FabricObject.prototype.borderDashArray = [4, 4];
  FabricObject.prototype.borderScaleFactor = 1.5;
}

export interface PageInfo {
  pageIndex: number;
  pageNumber: number;
  width: number; // PDF points
  height: number; // PDF points
  rotation: number;
}

export interface ExtractedTextItem {
  id: string;
  str: string;
  x: number; // PDF point X (from left)
  y: number; // PDF point Y (from top)
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  isBold?: boolean;
}

export interface PageState {
  fabricJSON: any;
  history: string[];
  historyIndex: number;
}

export class PdfEngine {
  private pdfBytes: Uint8Array | null = null;
  /** PDFium document handle — destroyed and replaced on each loadPdf() */
  private pdfiumDoc: any = null;
  private numPages: number = 0;
  private pages: PageInfo[] = [];
  private pageRotations: Map<number, number> = new Map();
  private deletedPages: Set<number> = new Set();
  private pageOrder: number[] = [];

  // Fabric canvas states stored per pageIndex
  private pageStates: Map<number, PageState> = new Map();
  private activeFabricCanvas: Canvas | null = null;
  private activePageIndex: number = 0;
  private activeScale: number = 1.3;

  /**
   * Load PDF binary buffer and extract page metadata via PDFium WASM
   */
  async loadPdf(fileData: ArrayBuffer | Uint8Array): Promise<PageInfo[]> {
    this.pdfBytes = new Uint8Array(fileData);
    this.pageStates.clear();
    this.pageRotations.clear();
    this.deletedPages.clear();

    // Destroy previous document to free WASM memory
    if (this.pdfiumDoc) {
      try { this.pdfiumDoc.destroy(); } catch (_) {}
      this.pdfiumDoc = null;
    }

    const library = await getPdfiumLibrary();
    this.pdfiumDoc = await library.loadDocument(this.pdfBytes);
    this.numPages = this.pdfiumDoc.getPageCount();
    this.pageOrder = Array.from({ length: this.numPages }, (_, i) => i);

    this.pages = [];
    for (let i = 0; i < this.numPages; i++) {
      const page = this.pdfiumDoc.getPage(i);
      const { originalWidth: w, originalHeight: h } = page.getOriginalSize();
      // PDFium doesn't expose rotation via this API; default to 0
      const rotation = 0;
      this.pages.push({
        pageIndex: i,
        pageNumber: i + 1,
        width: w,
        height: h,
        rotation,
      });
      this.pageRotations.set(i, rotation);

      // Initialize blank Fabric state for each page
      this.pageStates.set(i, {
        fabricJSON: null,
        history: ['{"version":"7.4.0","objects":[]}'],
        historyIndex: 0,
      });
    }

    return this.getVisiblePages();
  }

  getVisiblePages(): PageInfo[] {
    return this.pageOrder
      .filter((idx) => !this.deletedPages.has(idx))
      .map((idx) => {
        const p = this.pages[idx];
        return {
          ...p,
          rotation: this.pageRotations.get(idx) || 0,
        };
      });
  }

  getPageInfo(pageIndex: number): PageInfo | undefined {
    return this.pages.find((p) => p.pageIndex === pageIndex);
  }

  /**
   * Render PDF page to an HTMLCanvasElement using PDFium WASM.
   *
   * PDFium returns raw BGRA pixel data; we swap B↔R channels to produce
   * the RGBA layout required by the browser's ImageData API.
   */
  async renderPageToCanvas(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number = 1.3
  ): Promise<{ width: number; height: number; unscaledWidth: number; unscaledHeight: number }> {
    if (!this.pdfiumDoc) return { width: 0, height: 0, unscaledWidth: 0, unscaledHeight: 0 };

    const pageInfo = this.pages[pageIndex];
    if (!pageInfo) return { width: 0, height: 0, unscaledWidth: 0, unscaledHeight: 0 };

    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

    // Unscaled dimensions in PDF points
    const unscaledWidth = pageInfo.width;
    const unscaledHeight = pageInfo.height;

    // Scaled display pixel dimensions (CSS pixels)
    const displayW = Math.floor(unscaledWidth * scale);
    const displayH = Math.floor(unscaledHeight * scale);

    // Actual canvas pixel buffer at HiDPI
    const bufferW = Math.floor(displayW * dpr);
    const bufferH = Math.floor(displayH * dpr);

    canvas.width = bufferW;
    canvas.height = bufferH;
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return { width: displayW, height: displayH, unscaledWidth, unscaledHeight };

    const page = this.pdfiumDoc.getPage(pageIndex);

    // Render at full buffer resolution (scale * dpr) so it's crisp on HiDPI screens
    const renderScale = scale * dpr;
    const image = await page.render({ scale: renderScale, render: 'bitmap' });

    // PDFium outputs BGRA; ImageData requires RGBA — swap B and R channels in-place
    const bgraBuffer = new Uint8ClampedArray(image.data);
    for (let i = 0; i < bgraBuffer.length; i += 4) {
      const b = bgraBuffer[i];
      bgraBuffer[i] = bgraBuffer[i + 2]; // R ← B
      bgraBuffer[i + 2] = b;             // B ← R
    }

    const imageData = new ImageData(bgraBuffer, image.width, image.height);
    ctx.putImageData(imageData, 0, 0);

    return {
      width: displayW,
      height: displayH,
      unscaledWidth,
      unscaledHeight,
    };
  }

  /**
   * Generate thumbnail image for the page navigator sidebar
   */
  async generateThumbnail(pageIndex: number): Promise<string> {
    if (!this.pdfiumDoc) return '';
    const canvas = document.createElement('canvas');
    await this.renderPageToCanvas(pageIndex, canvas, 0.28);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /**
   * Extract text items from a PDF page for click-to-edit overlays and AI features.
   *
   * @hyzyla/pdfium exposes only page.getText() (flat string). We split by
   * newline to approximate line-level blocks, then evenly distribute their Y
   * positions across the page height. This gives good enough geometry for
   * the whiteout+Textbox overlay and is far simpler than the old PDF.js
   * transform-matrix heuristic that caused the alignment bugs.
   */
  async getPageTextItems(pageIndex: number): Promise<ExtractedTextItem[]> {
    if (!this.pdfiumDoc) return [];
    try {
      const page = this.pdfiumDoc.getPage(pageIndex);
      const pageInfo = this.pages[pageIndex];
      const rawText: string = page.getText();
      if (!rawText || rawText.trim().length === 0) return [];

      // Split into logical lines; filter blank lines
      const lines = rawText.split('\n').filter((l: string) => l.trim().length > 0);
      if (lines.length === 0) return [];

      const pageW = pageInfo.width;
      const pageH = pageInfo.height;

      // Estimate a uniform line height (fits all lines within page height with margins)
      const topMargin = pageH * 0.06;
      const bottomMargin = pageH * 0.06;
      const usableH = pageH - topMargin - bottomMargin;
      const lineH = Math.max(10, usableH / Math.max(lines.length, 1));
      // Approximate font size as ~75% of line height, matching typical leading
      const fontSize = Math.max(8, lineH * 0.75);

      const items: ExtractedTextItem[] = lines.map((str: string, i: number) => {
        const y = topMargin + i * lineH;
        // Estimate text width: average ~0.52× font-size per character for sans-serif
        const estimatedWidth = Math.min(str.length * fontSize * 0.52, pageW * 0.92);
        return {
          id: `text-line-${pageIndex}-${i}`,
          str,
          x: pageW * 0.04,           // ~4% left margin
          y,
          width: estimatedWidth,
          height: lineH,
          fontSize,
          fontFamily: 'Helvetica',
          isBold: false,
        };
      });

      return items;
    } catch (e) {
      console.warn('Could not extract text items from page', pageIndex, e);
      return [];
    }
  }

  /**
   * Bind and synchronize Fabric.js Canvas instance for active page
   */
  async attachFabricCanvas(
    fabricCanvas: Canvas,
    pageIndex: number,
    width: number,
    height: number,
    scale: number
  ) {
    // Save current active page state before switching
    if (this.activeFabricCanvas && this.activePageIndex !== pageIndex) {
      this.saveCurrentPageState();
    }

    this.activeFabricCanvas = fabricCanvas;
    this.activePageIndex = pageIndex;
    this.activeScale = scale;

    fabricCanvas.setDimensions({ width, height });

    const state = this.pageStates.get(pageIndex);
    if (state && state.fabricJSON) {
      await fabricCanvas.loadFromJSON(state.fabricJSON);
      fabricCanvas.renderAll();
    } else {
      fabricCanvas.clear();
      fabricCanvas.renderAll();
    }
  }

  /**
   * Save current active page's Fabric objects into JSON cache and history
   */
  saveCurrentPageState() {
    if (!this.activeFabricCanvas) return;
    const json = this.activeFabricCanvas.toJSON();
    const jsonStr = JSON.stringify(json);

    let state = this.pageStates.get(this.activePageIndex);
    if (!state) {
      state = {
        fabricJSON: json,
        history: [jsonStr],
        historyIndex: 0,
      };
      this.pageStates.set(this.activePageIndex, state);
    } else {
      state.fabricJSON = json;
      // Record to history only if content changed
      if (state.history[state.historyIndex] !== jsonStr) {
        state.history = state.history.slice(0, state.historyIndex + 1);
        state.history.push(jsonStr);
        state.historyIndex = state.history.length - 1;
      }
    }
  }

  /**
   * Record a new undoable action for current page
   */
  recordHistory() {
    this.saveCurrentPageState();
  }

  /**
   * Undo last action on active page
   */
  async undo(): Promise<boolean> {
    if (!this.activeFabricCanvas) return false;
    const state = this.pageStates.get(this.activePageIndex);
    if (!state || state.historyIndex <= 0) return false;

    state.historyIndex--;
    const prevJSON = JSON.parse(state.history[state.historyIndex]);
    state.fabricJSON = prevJSON;
    await this.activeFabricCanvas.loadFromJSON(prevJSON);
    this.activeFabricCanvas.renderAll();
    return true;
  }

  /**
   * Redo action on active page
   */
  async redo(): Promise<boolean> {
    if (!this.activeFabricCanvas) return false;
    const state = this.pageStates.get(this.activePageIndex);
    if (!state || state.historyIndex >= state.history.length - 1) return false;

    state.historyIndex++;
    const nextJSON = JSON.parse(state.history[state.historyIndex]);
    state.fabricJSON = nextJSON;
    await this.activeFabricCanvas.loadFromJSON(nextJSON);
    this.activeFabricCanvas.renderAll();
    return true;
  }

  rotatePage(pageIndex: number, degreesToAdd: number = 90) {
    const current = this.pageRotations.get(pageIndex) || 0;
    const newRot = (current + degreesToAdd) % 360;
    this.pageRotations.set(pageIndex, newRot);
  }

  deletePage(pageIndex: number) {
    this.deletedPages.add(pageIndex);
  }

  private hexToRgb(hex: string) {
    hex = hex.replace('#', '');
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    const num = parseInt(hex, 16);
    return {
      r: ((num >> 16) & 255) / 255,
      g: ((num >> 8) & 255) / 255,
      b: (num & 255) / 255,
    };
  }

  /**
   * Export final PDF document using pdf-lib, embedding vector text and Fabric annotations.
   * pdf-lib handles the write side; PDFium handles the read/render side.
   */
  async exportPdf(): Promise<Uint8Array> {
    if (!this.pdfBytes) {
      throw new Error('No PDF document loaded.');
    }

    // Ensure current active page state is saved
    this.saveCurrentPageState();

    const srcDoc = await PDFDocument.load(this.pdfBytes);
    const outDoc = await PDFDocument.create();

    const activePageIndices = this.pageOrder.filter((idx) => !this.deletedPages.has(idx));
    const copiedPages = await outDoc.copyPages(srcDoc, activePageIndices);

    for (let i = 0; i < copiedPages.length; i++) {
      const originalPageIndex = activePageIndices[i];
      const page = copiedPages[i];
      const rotation = this.pageRotations.get(originalPageIndex) || 0;
      page.setRotation(degrees(rotation));

      const { width: pageWidth, height: pageHeight } = page.getSize();
      const pageState = this.pageStates.get(originalPageIndex);

      if (pageState && pageState.fabricJSON && pageState.fabricJSON.objects?.length > 0) {
        // Render Fabric overlay at native PDF resolution into a temporary static canvas
        const staticCanvasEl = document.createElement('canvas');
        const overlayCanvas = new StaticCanvas(staticCanvasEl, {
          width: pageWidth,
          height: pageHeight,
        });

        await overlayCanvas.loadFromJSON(pageState.fabricJSON);
        overlayCanvas.renderAll();

        // Convert to high-resolution PNG for embedding
        const overlayDataUrl = overlayCanvas.toDataURL({
          format: 'png',
          multiplier: 2.0,
        });

        try {
          const embeddedOverlay = await outDoc.embedPng(overlayDataUrl);
          page.drawImage(embeddedOverlay, {
            x: 0,
            y: 0,
            width: pageWidth,
            height: pageHeight,
          });
        } catch (e) {
          console.warn('Could not embed raster overlay for page', originalPageIndex, e);
        }

        overlayCanvas.dispose();
      }

      outDoc.addPage(page);
    }

    return await outDoc.save();
  }

  /**
   * Extract all plain text across all pages for AI document processing.
   * Uses PDFium's getText() which is far more accurate than PDF.js's string concatenation.
   */
  async extractFullText(): Promise<{ pageIndex: number; text: string }[]> {
    if (!this.pdfiumDoc) return [];
    const results: { pageIndex: number; text: string }[] = [];
    for (let i = 0; i < this.numPages; i++) {
      const page = this.pdfiumDoc.getPage(i);
      const text: string = page.getText() || '';
      results.push({ pageIndex: i, text });
    }
    return results;
  }
}
