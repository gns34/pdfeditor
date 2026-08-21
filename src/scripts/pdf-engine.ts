import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
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

// Configure PDF.js worker to use local worker in public/
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  // Configure Stripi Brand style defaults for Fabric.js interactive controls
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
}

export interface PageState {
  fabricJSON: any;
  history: string[];
  historyIndex: number;
}

export class PdfEngine {
  private pdfBytes: Uint8Array | null = null;
  private pdfDoc: any = null;
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
   * Load PDF binary buffer and extract page viewports
   */
  async loadPdf(fileData: ArrayBuffer | Uint8Array): Promise<PageInfo[]> {
    this.pdfBytes = new Uint8Array(fileData);
    this.pageStates.clear();
    this.pageRotations.clear();
    this.deletedPages.clear();

    const loadingTask = pdfjsLib.getDocument({
      data: this.pdfBytes,
      useSystemFonts: true,
    });
    this.pdfDoc = await loadingTask.promise;
    this.numPages = this.pdfDoc.numPages;
    this.pageOrder = Array.from({ length: this.numPages }, (_, i) => i);

    this.pages = [];
    for (let i = 1; i <= this.numPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      this.pages.push({
        pageIndex: i - 1,
        pageNumber: i,
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation || 0,
      });
      this.pageRotations.set(i - 1, viewport.rotation || 0);

      // Initialize blank state for each page
      this.pageStates.set(i - 1, {
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
   * Render PDF Page to a raster canvas with PDF.js at crisp high DPI
   */
  async renderPageToCanvas(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number = 1.3
  ): Promise<{ width: number; height: number; unscaledWidth: number; unscaledHeight: number }> {
    if (!this.pdfDoc) return { width: 0, height: 0, unscaledWidth: 0, unscaledHeight: 0 };

    const pageNum = pageIndex + 1;
    const page = await this.pdfDoc.getPage(pageNum);
    const rotation = this.pageRotations.get(pageIndex) || 0;
    const viewport = page.getViewport({ scale, rotation });
    const unscaledViewport = page.getViewport({ scale: 1.0, rotation });

    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

    // Set actual canvas pixel buffer for crisp high-DPI rendering
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return { width: viewport.width, height: viewport.height, unscaledWidth: unscaledViewport.width, unscaledHeight: unscaledViewport.height };

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    const renderContext = {
      canvasContext: ctx,
      viewport: viewport,
    };

    await page.render(renderContext).promise;
    ctx.restore();

    return {
      width: Math.floor(viewport.width),
      height: Math.floor(viewport.height),
      unscaledWidth: unscaledViewport.width,
      unscaledHeight: unscaledViewport.height,
    };
  }

  /**
   * Generate thumbnail image for page navigator
   */
  async generateThumbnail(pageIndex: number): Promise<string> {
    if (!this.pdfDoc) return '';
    const canvas = document.createElement('canvas');
    await this.renderPageToCanvas(pageIndex, canvas, 0.28);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /**
   * Extract text items from PDF page for in-place text editing & AI PII scanning
   */
  async getPageTextItems(pageIndex: number): Promise<ExtractedTextItem[]> {
    if (!this.pdfDoc) return [];
    try {
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const textContent = await page.getTextContent();
      const rotation = this.pageRotations.get(pageIndex) || 0;
      const viewport = page.getViewport({ scale: 1.0, rotation });

      return textContent.items
        .filter((item: any) => item.str && item.str.trim().length > 0)
        .map((item: any, idx: number) => {
          const tx = item.transform; // [scaleX, skewY, skewX, scaleY, tx, ty]
          const fontSize = Math.abs(tx[3]) || 12;
          const x = tx[4];
          const y = viewport.height - tx[5] - fontSize;
          const width = item.width || item.str.length * (fontSize * 0.55);
          const height = fontSize * 1.15;

          return {
            id: `text-item-${pageIndex}-${idx}`,
            str: item.str,
            x,
            y,
            width,
            height,
            fontSize,
            fontFamily: item.fontName || 'Helvetica',
          };
        });
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

    fabricCanvas.setDimensions({
      width,
      height,
    });

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
      // Record to history if changed
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
   * Export final PDF document using pdf-lib, embedding vector text and Fabric annotations
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
        // Create an offscreen static canvas to render Fabric overlay at high resolution (2x)
        const staticCanvasEl = document.createElement('canvas');
        const overlayCanvas = new StaticCanvas(staticCanvasEl, {
          width: pageWidth,
          height: pageHeight,
        });

        // Load page JSON
        await overlayCanvas.loadFromJSON(pageState.fabricJSON);
        overlayCanvas.renderAll();

        // Convert the rendered canvas overlay to high-resolution PNG
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

        // Dispose temporary static canvas
        overlayCanvas.dispose();
      }

      outDoc.addPage(page);
    }

    return await outDoc.save();
  }

  /**
   * Extract all plain text across all pages for AI document processing
   */
  async extractFullText(): Promise<{ pageIndex: number; text: string }[]> {
    if (!this.pdfDoc) return [];
    const results: { pageIndex: number; text: string }[] = [];
    for (let i = 1; i <= this.numPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      results.push({ pageIndex: i - 1, text: pageText });
    }
    return results;
  }
}

