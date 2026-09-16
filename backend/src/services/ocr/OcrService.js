import { OcrUnavailableError } from '../../common/errors.js';

/**
 * OCR provider interface + registry. Providers declare which MIME types
 * they support and an `isAvailable()` probe. Cost-free MVP ships the
 * PlainText provider (always available) and, if the optional tesseract.js
 * dependency is installed, a real image OCR provider.
 */
export class PlainTextOcrProvider {
  name = 'plain-text';

  supports(mimeType) {
    return (
      mimeType === 'text/plain' ||
      mimeType === 'text/markdown' ||
      mimeType === 'text/csv' ||
      mimeType === 'application/json' ||
      mimeType === 'text'
    );
  }

  async isAvailable() {
    return true;
  }

  async extract({ buffer }) {
    const text = buffer.toString('utf8');
    const printable = /^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]*$/.test(text);
    if (!printable) {
      throw new OcrUnavailableError('File does not look like plain text');
    }
    return { text, confidence: 1.0, provider: this.name };
  }
}

/** Optional tesseract.js-backed provider — loaded only if dependency exists. */
export class TesseractJsOcrProvider {
  name = 'tesseract.js';

  supports(mimeType) {
    return /^image\/(png|jpe?g|bmp|webp|tiff?)$/.test(mimeType || '');
  }

  async isAvailable() {
    try {
      await import('tesseract.js');
      return true;
    } catch {
      return false;
    }
  }

  async extract({ buffer }) {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer);
      const confidence = typeof data.confidence === 'number' ? data.confidence / 100 : null;
      return { text: data.text || '', confidence, provider: this.name };
    } finally {
      await worker.terminate();
    }
  }
}

export class OcrService {
  /** @param {Array} providers ordered; first available provider supporting the MIME wins */
  constructor(providers = null) {
    this.providers = providers || [new PlainTextOcrProvider(), new TesseractJsOcrProvider()];
  }

  async providerFor(mimeType) {
    for (const p of this.providers) {
      if (p.supports(mimeType) && (await p.isAvailable())) return p;
    }
    return null;
  }

  /**
   * @returns {{text, confidence, provider}} or throws OcrUnavailableError.
   */
  async extractText({ buffer, mimeType }) {
    const provider = await this.providerFor(mimeType);
    if (!provider) {
      throw new OcrUnavailableError(
        `No OCR provider available for '${mimeType}'. ` +
          `The cost-free MVP reads plain-text reports directly. ` +
          `For image/PDF reports, paste the report text into the upload dialog.`,
      );
    }
    return provider.extract({ buffer, mimeType });
  }
}
