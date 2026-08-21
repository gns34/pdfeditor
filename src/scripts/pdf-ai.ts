export interface RedactBox {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  mode: 'blackout' | 'whiteout';
}

export interface PiiMatch {
  type: 'email' | 'creditCard' | 'ssn' | 'phone' | 'custom';
  label: string;
  matchedText: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentSummary {
  wordCount: number;
  pageCount: number;
  readingTimeMinutes: number;
  executiveSummary: string;
  keyTakeaways: string[];
  sensitiveDataDetected: number;
}

export interface QAResult {
  question: string;
  answer: string;
  relevantSnippets: Array<{ pageIndex: number; snippet: string }>;
}

export class PdfAiAssistant {
  // Common Regex patterns for sensitive PII data
  private static EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  private static CC_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;
  private static SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
  private static PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

  /**
   * Scan PDF text items and detect PII coordinates for 1-click auto-redaction
   */
  static detectPii(
    pageIndex: number,
    textItems: Array<{ str: string; x: number; y: number; width: number; height: number }>,
    customKeywords: string[] = []
  ): PiiMatch[] {
    const matches: PiiMatch[] = [];

    for (const item of textItems) {
      const text = item.str;
      if (!text || text.trim().length === 0) continue;

      // 1. Check Emails
      const emails = text.match(this.EMAIL_REGEX);
      if (emails) {
        for (const e of emails) {
          matches.push({
            type: 'email',
            label: 'Email Address',
            matchedText: e,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 80),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 2. Check Credit Cards
      const ccs = text.match(this.CC_REGEX);
      if (ccs) {
        for (const cc of ccs) {
          matches.push({
            type: 'creditCard',
            label: 'Credit Card Number',
            matchedText: cc,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 90),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 3. Check SSN
      const ssns = text.match(this.SSN_REGEX);
      if (ssns) {
        for (const ssn of ssns) {
          matches.push({
            type: 'ssn',
            label: 'Social Security Number',
            matchedText: ssn,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 70),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 4. Check Phones
      const phones = text.match(this.PHONE_REGEX);
      if (phones) {
        for (const ph of phones) {
          if (ph.replace(/\D/g, '').length >= 10) {
            matches.push({
              type: 'phone',
              label: 'Phone Number',
              matchedText: ph,
              pageIndex,
              x: item.x,
              y: item.y - 2,
              width: Math.max(item.width, 75),
              height: Math.max(item.height + 4, 16),
            });
          }
        }
      }

      // 5. Custom Keywords
      for (const kw of customKeywords) {
        if (kw.trim() && text.toLowerCase().includes(kw.toLowerCase().trim())) {
          matches.push({
            type: 'custom',
            label: `Keyword: "${kw}"`,
            matchedText: kw,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 60),
            height: Math.max(item.height + 4, 16),
          });
        }
      }
    }

    return matches;
  }

  /**
   * Convert detected PII matches into RedactBox items
   */
  static piiToAnnotations(matches: PiiMatch[], mode: 'blackout' | 'whiteout' = 'blackout'): RedactBox[] {
    return matches.map((m, idx) => ({
      id: `ai-redact-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
      pageIndex: m.pageIndex,
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
      mode,
    }));
  }

  /**
   * Generate an in-browser executive summary & key insights from document text
   */
  static summarizeDocument(pages: Array<{ pageIndex: number; text: string }>): DocumentSummary {
    const fullText = pages.map(p => p.text).join('\n\n');
    const words = fullText.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const pageCount = pages.length;
    const readingTimeMinutes = Math.max(1, Math.round(wordCount / 200));

    // Detect sensitive items count
    const emailCount = (fullText.match(this.EMAIL_REGEX) || []).length;
    const ccCount = (fullText.match(this.CC_REGEX) || []).length;
    const ssnCount = (fullText.match(this.SSN_REGEX) || []).length;
    const phoneCount = (fullText.match(this.PHONE_REGEX) || []).length;
    const sensitiveDataDetected = emailCount + ccCount + ssnCount + phoneCount;

    // Sentence extraction heuristics
    const sentences = fullText
      .split(/(?<=[.?!])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 30 && s.length < 250);

    let executiveSummary = '';
    const keyTakeaways: string[] = [];

    if (sentences.length > 0) {
      executiveSummary = sentences.slice(0, Math.min(3, sentences.length)).join(' ');
      
      // Select informative sentences containing key markers
      const actionKeywords = ['shall', 'must', 'agrees', 'payment', 'total', 'liability', 'effective', 'termination', 'confidential', 'term'];
      const filtered = sentences.filter(s => actionKeywords.some(k => s.toLowerCase().includes(k)));
      
      if (filtered.length > 0) {
        for (let i = 0; i < Math.min(5, filtered.length); i++) {
          keyTakeaways.push(filtered[i]);
        }
      } else {
        for (let i = 0; i < Math.min(4, sentences.length); i++) {
          keyTakeaways.push(sentences[i]);
        }
      }
    } else {
      executiveSummary = 'This document contains visual diagrams or structured tabular content without long-form paragraphs.';
      keyTakeaways.push(`Document contains ${pageCount} pages and approximately ${wordCount} words.`);
      keyTakeaways.push('All text elements are ready for in-browser editing, redaction, and annotation.');
    }

    return {
      wordCount,
      pageCount,
      readingTimeMinutes,
      executiveSummary,
      keyTakeaways,
      sensitiveDataDetected,
    };
  }

  /**
   * Client-side Q&A context search across document
   */
  static askQuestion(pages: Array<{ pageIndex: number; text: string }>, query: string): QAResult {
    const qLower = query.toLowerCase().trim();
    const qWords = qLower.split(/\s+/).filter(w => w.length > 2);
    const snippets: Array<{ pageIndex: number; snippet: string; score: number }> = [];

    for (const p of pages) {
      const sentences = p.text.split(/(?<=[.?!])\s+/);
      for (const s of sentences) {
        const sLower = s.toLowerCase();
        let score = 0;
        for (const w of qWords) {
          if (sLower.includes(w)) {
            score += 1;
          }
        }
        if (score > 0 && s.trim().length > 20) {
          snippets.push({
            pageIndex: p.pageIndex,
            snippet: s.trim(),
            score,
          });
        }
      }
    }

    snippets.sort((a, b) => b.score - a.score);
    const topSnippets = snippets.slice(0, 3);

    let answer = '';
    if (topSnippets.length > 0) {
      answer = `Based on your document (Page ${topSnippets[0].pageIndex + 1}): "${topSnippets[0].snippet}"`;
    } else {
      answer = `I could not find a direct mention of "${query}" in this document. You can highlight or search for specific terms using the text tool.`;
    }

    return {
      question: query,
      answer,
      relevantSnippets: topSnippets.map(s => ({ pageIndex: s.pageIndex, snippet: s.snippet })),
    };
  }

  /**
   * Helper to generate cursive text signature as transparent PNG data URI
   */
  static generateCursiveSignature(name: string, fontStyle: 'dancing' | 'pacifico' | 'allura' = 'dancing', color: string = '#0d253d'): string {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    let fontName = 'cursive, "Brush Script MT", "Segoe Script", sans-serif';
    if (fontStyle === 'dancing') {
      fontName = '"Dancing Script", cursive, sans-serif';
    } else if (fontStyle === 'pacifico') {
      fontName = '"Pacifico", cursive, sans-serif';
    }

    ctx.font = `italic 46px ${fontName}`;
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);

    return canvas.toDataURL('image/png');
  }
}
