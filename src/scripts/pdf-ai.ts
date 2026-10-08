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
  type: 'email' | 'creditCard' | 'ssn' | 'phone' | 'nif' | 'iban' | 'cc' | 'custom';
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
  // Regex patterns for sensitive data in Portugal and International
  private static EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  private static CC_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;
  private static SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
  // Portugal NIF (Número de Identificação Fiscal - 9 dígitos começando por 1, 2, 3, 5, 6, 8, 9)
  private static PT_NIF_REGEX = /\b[1235689]\d{2}[ -]?\d{3}[ -]?\d{3}\b/g;
  // Portugal IBAN (começa por PT50 e tem 21 dígitos numéricos a seguir)
  private static PT_IBAN_REGEX = /\bPT50(?:[ -]?\d{4}){5}[ -]?\d{1}\b/gi;
  // Portugal Cartão de Cidadão (8 dígitos + 1 dígito controlo + 2 letras + 1 dígito ex: 12345678 9 ZZ4)
  private static PT_CC_DOC_REGEX = /\b\d{8}[ -]?\d[ -]?[A-Z0-9]{3}\b/gi;
  // Portugal Telefone/Telemóvel (+351 ou 9x/2x com 9 dígitos)
  private static PHONE_REGEX = /(?:\+351[ -]?)?(?:9[1236]\d{1}[ -]?\d{3}[ -]?\d{3}|2\d{2}[ -]?\d{3}[ -]?\d{3})\b|(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

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

      // 1. Portugal NIF (Número de Identificação Fiscal)
      const nifs = text.match(this.PT_NIF_REGEX);
      if (nifs) {
        for (const nif of nifs) {
          matches.push({
            type: 'nif',
            label: 'NIF (Identificação Fiscal)',
            matchedText: nif,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 70),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 2. Portugal IBAN (PT50)
      const ibans = text.match(this.PT_IBAN_REGEX);
      if (ibans) {
        for (const iban of ibans) {
          matches.push({
            type: 'iban',
            label: 'IBAN Português (PT50)',
            matchedText: iban,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 110),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 3. Portugal Cartão de Cidadão
      const ccsDoc = text.match(this.PT_CC_DOC_REGEX);
      if (ccsDoc) {
        for (const ccDoc of ccsDoc) {
          matches.push({
            type: 'cc',
            label: 'Cartão de Cidadão (CC)',
            matchedText: ccDoc,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 85),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 4. Emails
      const emails = text.match(this.EMAIL_REGEX);
      if (emails) {
        for (const e of emails) {
          matches.push({
            type: 'email',
            label: 'Endereço de E-mail',
            matchedText: e,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 80),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 5. Credit Cards
      const ccs = text.match(this.CC_REGEX);
      if (ccs) {
        for (const cc of ccs) {
          matches.push({
            type: 'creditCard',
            label: 'Cartão de Crédito',
            matchedText: cc,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 90),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 6. Phones / Telemóveis
      const phones = text.match(this.PHONE_REGEX);
      if (phones) {
        for (const ph of phones) {
          if (ph.replace(/\D/g, '').length >= 9) {
            matches.push({
              type: 'phone',
              label: 'Telemóvel / Telefone',
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

      // 7. SSN
      const ssns = text.match(this.SSN_REGEX);
      if (ssns) {
        for (const ssn of ssns) {
          matches.push({
            type: 'ssn',
            label: 'Número de Segurança Social',
            matchedText: ssn,
            pageIndex,
            x: item.x,
            y: item.y - 2,
            width: Math.max(item.width, 70),
            height: Math.max(item.height + 4, 16),
          });
        }
      }

      // 8. Custom Keywords
      for (const kw of customKeywords) {
        if (kw.trim() && text.toLowerCase().includes(kw.toLowerCase().trim())) {
          matches.push({
            type: 'custom',
            label: `Termo: "${kw}"`,
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
    const nifCount = (fullText.match(this.PT_NIF_REGEX) || []).length;
    const ibanCount = (fullText.match(this.PT_IBAN_REGEX) || []).length;
    const phoneCount = (fullText.match(this.PHONE_REGEX) || []).length;
    const sensitiveDataDetected = emailCount + ccCount + ssnCount + nifCount + ibanCount + phoneCount;

    // Sentence extraction heuristics
    const sentences = fullText
      .split(/(?<=[.?!])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 30 && s.length < 250);

    let executiveSummary = '';
    const keyTakeaways: string[] = [];

    if (sentences.length > 0) {
      executiveSummary = sentences.slice(0, Math.min(3, sentences.length)).join(' ');
      
      // Select informative sentences containing key markers in Portuguese & English
      const actionKeywords = ['deverá', 'acordo', 'pagamento', 'responsabilidade', 'vigência', 'rescisão', 'confidencial', 'prazo', 'cláusula', 'shall', 'must', 'agrees', 'payment', 'total', 'liability'];
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
      executiveSummary = 'Este documento contém diagramas visuais ou tabelas estruturadas sem blocos de texto contínuo.';
      keyTakeaways.push(`O documento contém ${pageCount} páginas e cerca de ${wordCount} palavras.`);
      keyTakeaways.push('Todos os elementos de texto estão prontos para edição, ocultação e anotação local no navegador.');
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
      answer = `Com base no documento (Página ${topSnippets[0].pageIndex + 1}): «${topSnippets[0].snippet}»`;
    } else {
      answer = `Não foi encontrada nenhuma menção direta a «${query}» no documento. Pode pesquisar termos específicos ou utilizar a ferramenta de texto para localizar cláusulas.`;
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
