import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
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

// Configure the PDF.js worker. The worker file is copied to /public/ by
// vite-plugin-static-copy (see astro.config.mjs).
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
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
  width: number; // PDF points (unscaled)
  height: number; // PDF points (unscaled)
  rotation: number;
}

export interface ExtractedTextItem {
  id: string;
  str: string;
  x: number; // PDF point X (from left, top-origin)
  y: number; // PDF point Y (from top, top-origin)
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

/**
 * Fabric overlay object type tags used during PDF export to determine
 * how each object should be serialized into the pdf-lib content stream.
 */
type FabricExportTag = 'whiteout' | 'text' | 'drawing' | 'image';

export class PdfEngine {
  private pdfBytes: Uint8Array | null = null;
  /** pdf.js document handle — replaced on each loadPdf() */
  private pdfJsDoc: PDFDocumentProxy | null = null;
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
   * Load PDF binary buffer and extract page metadata via PDF.js.
   */
  async loadPdf(fileData: ArrayBuffer | Uint8Array): Promise<PageInfo[]> {
    this.pdfBytes = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
    this.pageStates.clear();
    this.pageRotations.clear();
    this.deletedPages.clear();

    // Destroy previous document to free memory
    if (this.pdfJsDoc) {
      try { await this.pdfJsDoc.destroy(); } catch (_) {}
      this.pdfJsDoc = null;
    }

    // pdf.js requires a copy of the data (it takes ownership of the buffer)
    const dataCopy = new Uint8Array(this.pdfBytes);
    this.pdfJsDoc = await pdfjsLib.getDocument({ data: dataCopy }).promise;
    this.numPages = this.pdfJsDoc.numPages;
    this.pageOrder = Array.from({ length: this.numPages }, (_, i) => i);

    this.pages = [];
    for (let i = 0; i < this.numPages; i++) {
      const pdfPage = await this.pdfJsDoc.getPage(i + 1); // pdf.js is 1-indexed
      const viewport = pdfPage.getViewport({ scale: 1.0 });
      const rotation = pdfPage.rotate ?? 0;
      this.pages.push({
        pageIndex: i,
        pageNumber: i + 1,
        width: viewport.width,
        height: viewport.height,
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
          rotation: this.pageRotations.get(idx) ?? 0,
        };
      });
  }

  getPageInfo(pageIndex: number): PageInfo | undefined {
    return this.pages.find((p) => p.pageIndex === pageIndex);
  }

  /**
   * Render PDF page to an HTMLCanvasElement using PDF.js.
   *
   * PDF.js outputs RGBA directly — no channel-swap needed.
   * HiDPI is handled by scaling the viewport by devicePixelRatio.
   */
  async renderPageToCanvas(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number = 1.3
  ): Promise<{ width: number; height: number; unscaledWidth: number; unscaledHeight: number }> {
    if (!this.pdfJsDoc) return { width: 0, height: 0, unscaledWidth: 0, unscaledHeight: 0 };

    const pageInfo = this.pages[pageIndex];
    if (!pageInfo) return { width: 0, height: 0, unscaledWidth: 0, unscaledHeight: 0 };

    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

    const pdfPage = await this.pdfJsDoc.getPage(pageIndex + 1);
    const viewport = pdfPage.getViewport({ scale });

    const unscaledWidth = pageInfo.width;
    const unscaledHeight = pageInfo.height;
    const displayW = Math.floor(viewport.width);
    const displayH = Math.floor(viewport.height);
    const bufferW = Math.floor(displayW * dpr);
    const bufferH = Math.floor(displayH * dpr);

    canvas.width = bufferW;
    canvas.height = bufferH;
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return { width: displayW, height: displayH, unscaledWidth, unscaledHeight };

    // Scale context for HiDPI rendering
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const hiDpiViewport = pdfPage.getViewport({ scale });
    await pdfPage.render({ canvasContext: ctx, viewport: hiDpiViewport }).promise;

    return { width: displayW, height: displayH, unscaledWidth, unscaledHeight };
  }

  /**
   * Generate thumbnail image for the page navigator sidebar.
   */
  async generateThumbnail(pageIndex: number): Promise<string> {
    if (!this.pdfJsDoc) return '';
    const canvas = document.createElement('canvas');
    await this.renderPageToCanvas(pageIndex, canvas, 0.28);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /**
   * Extract text items from a PDF page using PDF.js getTextContent().
   *
   * PDF.js returns real transform matrices with pixel-perfect per-glyph
   * positions. This completely replaces the old @hyzyla/pdfium heuristic
   * (which split by newline and evenly distributed Y positions — causing
   * misaligned click-to-edit badges).
   *
   * PDF.js coordinate origin is bottom-left; we convert to top-left here.
   */
  async getPageTextItems(pageIndex: number): Promise<ExtractedTextItem[]> {
    if (!this.pdfJsDoc) return [];
    try {
      const pdfPage = await this.pdfJsDoc.getPage(pageIndex + 1);
      const viewport = pdfPage.getViewport({ scale: 1.0 });
      const textContent = await pdfPage.getTextContent();

      const items: ExtractedTextItem[] = [];
      for (let i = 0; i < textContent.items.length; i++) {
        const rawItem = textContent.items[i];
        // PDF.js TextItem has: str, transform[6], width, height, fontName
        const item = rawItem as TextItem;
        if (!item.str || item.str.trim().length === 0) continue;

        // transform = [a, b, c, d, tx, ty] — tx/ty are the glyph origin in PDF coords
        const [a, b, c, d, tx, ty] = item.transform;

        // Compute font size from the transform matrix scale factor
        const scaleX = Math.sqrt(a * a + b * b);
        const fontSize = Math.max(6, scaleX);

        // Convert PDF bottom-left origin → top-left origin for canvas
        const x = tx;
        const y = viewport.height - ty - fontSize; // subtract fontSize for top of glyph

        // Item width from PDF.js; estimate height from font size
        const itemWidth = item.width > 0 ? item.width : item.str.length * fontSize * 0.55;
        const itemHeight = item.height > 0 ? item.height : fontSize * 1.2;

        // Detect bold from font name heuristic
        const fontName = (item as any).fontName || 'Helvetica';
        const isBold = /bold/i.test(fontName);
        const fontFamily = /Times|Serif/i.test(fontName)
          ? 'serif'
          : /Courier|Mono/i.test(fontName)
          ? 'monospace'
          : 'sans-serif';

        items.push({
          id: `text-item-${pageIndex}-${i}`,
          str: item.str,
          x,
          y,
          width: itemWidth,
          height: itemHeight,
          fontSize,
          fontFamily,
          isBold,
        });
      }

      return items;
    } catch (e) {
      console.warn('Could not extract text items from page', pageIndex, e);
      return [];
    }
  }

  /**
   * Bind and synchronize Fabric.js Canvas instance for active page.
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
   * Save current active page's Fabric objects into JSON cache and history.
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

  /** Record a new undoable action for current page. */
  recordHistory() {
    this.saveCurrentPageState();
  }

  /** Undo last action on active page. */
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

  /** Redo action on active page. */
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
   * Classify a Fabric object for PDF export strategy.
   *
   * - 'whiteout' → white Rect with no stroke → write pdf-lib rectangle (vector)
   * - 'text'     → Textbox/IText with user text → write pdf-lib text (vector, searchable)
   * - 'image'    → FabricImage → embed as PNG raster
   * - 'drawing'  → everything else (freehand paths, shapes) → rasterize to PNG
   */
  private classifyFabricObject(obj: any): FabricExportTag {
    if (obj.type === 'image') return 'image';
    if ((obj.type === 'textbox' || obj.type === 'i-text') && obj.text !== undefined) return 'text';
    if (obj.type === 'rect' && obj.fill === '#ffffff' && (!obj.stroke || obj.stroke === 'transparent')) {
      return 'whiteout';
    }
    return 'drawing';
  }

  /**
   * Export final PDF document.
   *
   * BentoPDF-inspired strategy:
   * - Whiteout Rects   → pdf-lib drawRectangle (vector, no data leak)
   * - Textboxes        → pdf-lib drawText (vector, searchable in exported PDF)
   * - Freehand / shapes → rasterized via StaticCanvas (png embed, only for ink/shapes)
   * - Images/signatures → embedded as PNG via pdf-lib embedPng
   *
   * This eliminates the old approach of rasterizing the entire page overlay
   * as a full-page PNG, which inflated file size and made text unsearchable.
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
        const objects: any[] = pageState.fabricJSON.objects;

        // Separate objects by export strategy
        const vectorObjects = objects.filter((o) => {
          const tag = this.classifyFabricObject(o);
          return tag === 'whiteout' || tag === 'text';
        });
        const rasterObjects = objects.filter((o) => {
          const tag = this.classifyFabricObject(o);
          return tag === 'drawing' || tag === 'image';
        });

        // --- 1. Raster layer: freehand drawings, shapes, images ---
        // Only rasterize objects that cannot be expressed as vector PDF ops.
        if (rasterObjects.length > 0) {
          const fabricScale = this.activeScale || 1.3;

          // Build a partial Fabric JSON with only raster objects
          const rasterJSON = {
            ...pageState.fabricJSON,
            objects: rasterObjects,
          };

          const staticCanvasEl = document.createElement('canvas');
          // Render at native PDF point resolution (unscaled)
          const renderW = Math.round(pageWidth);
          const renderH = Math.round(pageHeight);
          const overlayCanvas = new StaticCanvas(staticCanvasEl, {
            width: renderW,
            height: renderH,
          });

          // Fabric objects were positioned in display-scale coordinates;
          // scale them back down to PDF point space for embedding.
          const scaleDown = 1 / fabricScale;

          // Temporarily patch the JSON coordinates
          const scaledRasterJSON = {
            ...rasterJSON,
            objects: rasterJSON.objects.map((obj: any) => ({
              ...obj,
              left: (obj.left ?? 0) * scaleDown,
              top: (obj.top ?? 0) * scaleDown,
              scaleX: (obj.scaleX ?? 1) * scaleDown,
              scaleY: (obj.scaleY ?? 1) * scaleDown,
              fontSize: obj.fontSize ? obj.fontSize * scaleDown : obj.fontSize,
              strokeWidth: obj.strokeWidth ? obj.strokeWidth * scaleDown : obj.strokeWidth,
            })),
          };

          await overlayCanvas.loadFromJSON(scaledRasterJSON);
          overlayCanvas.renderAll();

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

        // --- 2. Vector layer: whiteout rects + text boxes ---
        // These are written as native PDF content stream operations.
        const fabricScale = this.activeScale || 1.3;
        const scaleDown = 1 / fabricScale;
        // pdf-lib origin is bottom-left; Fabric/canvas origin is top-left.
        // Conversion: pdfY = pageHeight - (fabricTop * scaleDown) - objectHeight
        const helvetica = await outDoc.embedFont(StandardFonts.Helvetica);
        const helveticaBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

        for (const obj of vectorObjects) {
          const tag = this.classifyFabricObject(obj);

          if (tag === 'whiteout') {
            const x = (obj.left ?? 0) * scaleDown;
            const w = (obj.width ?? 0) * (obj.scaleX ?? 1) * scaleDown;
            const h = (obj.height ?? 0) * (obj.scaleY ?? 1) * scaleDown;
            const pdfY = pageHeight - ((obj.top ?? 0) * scaleDown) - h;

            page.drawRectangle({
              x,
              y: pdfY,
              width: Math.max(w, 1),
              height: Math.max(h, 1),
              color: rgb(1, 1, 1),
              borderWidth: 0,
            });
          } else if (tag === 'text') {
            const text: string = obj.text ?? '';
            if (!text.trim()) continue;

            const fabricFontSize: number = (obj.fontSize ?? 12) * scaleDown;
            const clampedSize = Math.max(4, Math.min(fabricFontSize, 72));

            const fillHex: string = obj.fill ?? '#000000';
            const fillRgb = this.hexToRgb(fillHex);
            const isBold = obj.fontWeight === 'bold' || obj.fontWeight === 700;
            const font = isBold ? helveticaBold : helvetica;

            const x = (obj.left ?? 0) * scaleDown;
            const h = (obj.height ?? 0) * (obj.scaleY ?? 1) * scaleDown;
            // Position text baseline: top of textbox + font size offset
            const pdfY = pageHeight - ((obj.top ?? 0) * scaleDown) - clampedSize;

            // Handle multiline textboxes: split by newline and draw each line
            const lines = text.split('\n');
            const lineHeight = clampedSize * 1.2;
            for (let li = 0; li < lines.length; li++) {
              const lineText = lines[li];
              if (!lineText.trim()) continue;
              try {
                page.drawText(lineText, {
                  x: Math.max(0, x),
                  y: Math.max(0, pdfY - li * lineHeight),
                  size: clampedSize,
                  font,
                  color: rgb(fillRgb.r, fillRgb.g, fillRgb.b),
                  maxWidth: pageWidth - x,
                });
              } catch (e) {
                // pdf-lib may reject certain unicode characters — skip gracefully
                console.warn('Could not draw text line to PDF:', lineText, e);
              }
            }
          }
        }
      }

      outDoc.addPage(page);
    }

    return await outDoc.save();
  }

  /**
   * Extract all plain text across all pages for AI document processing.
   * Uses PDF.js getTextContent() which provides accurate glyph-level data.
   */
  async extractFullText(): Promise<{ pageIndex: number; text: string }[]> {
    if (!this.pdfJsDoc) return [];
    const results: { pageIndex: number; text: string }[] = [];
    for (let i = 0; i < this.numPages; i++) {
      const pdfPage = await this.pdfJsDoc.getPage(i + 1);
      const textContent = await pdfPage.getTextContent();
      const text = textContent.items
        .filter((item): item is TextItem => 'str' in item)
        .map((item) => item.str)
        .join(' ');
      results.push({ pageIndex: i, text });
    }
    return results;
  }
}
