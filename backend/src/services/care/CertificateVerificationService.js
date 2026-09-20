import { createHash } from 'node:crypto';
import { ValidationError } from '../../common/errors.js';

/**
 * Medical-council certificate check — the gate in front of the doctor console.
 *
 * What this build can honestly do, and what it deliberately does NOT do:
 *
 *   DOES   read the uploaded certificate (PDF text layer / plain text / image
 *          OCR when available), look for the registration number the doctor
 *          typed and for their name, and record every check with its verdict;
 *   DOES   refuse a document whose readable text contradicts the registration
 *          number (a wrong number is the single most common honest mistake, and
 *          it is also what a borrowed certificate looks like);
 *   DOES   keep a sha256 of the file so the exact document that was checked can
 *          be identified later without ever storing the document itself;
 *   DOES NOT call any medical council registry, and does not store the
 *          certificate — every response is labelled `mode: 'mock'` for exactly
 *          that reason.
 *
 * Deterministic by design: the same file and the same number always produce
 * the same verdict, so the doctor console can show *why* it decided.
 */

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
]);

/**
 * Council-issued numbers look like `MCI-123456`, `TNMC/12345`, `MH-12345`,
 * `MCI-DEMO-4471` or plain `12345`: alphanumerics, dashes and slashes, starting
 * with a letter or digit, and — the real signal — at least three digits.
 */
const REGISTRATION_RE = /^(?=(?:.*\d){3,})[A-Z0-9][A-Z0-9\-/ ]{2,39}$/;

const CHECK_LABELS = {
  'certificate.present': 'Certificate attached',
  'certificate.type': 'File type',
  'certificate.size': 'File size',
  'registration.format': 'Registration number format',
  'registration.matches_profile': 'Matches your kivo profile',
  'certificate.text_readable': 'Certificate text',
  'certificate.number_found': 'Number on certificate',
  'certificate.name_found': 'Name on certificate',
};

const stripToCompare = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class CertificateVerificationService {
  constructor({ config, ocrService = null }) {
    this.config = config;
    this.ocr = ocrService;
  }

  get maxBytes() {
    return this.config.maxCertificateBytes;
  }

  /** Metadata the UI needs to render the upload control without hardcoding rules. */
  get policy() {
    return {
      mode: 'mock',
      maxBytes: this.maxBytes,
      acceptedMime: [...ALLOWED_MIME],
      accept: '.pdf,.png,.jpg,.jpeg,.webp,.txt',
      label: 'Medical council certificate',
      note:
        'We read the registration number and your name from the certificate you upload and keep a ' +
        'fingerprint of the file. No council registry is contacted and the document itself is not stored ' +
        'in this build.',
    };
  }

  static check(key, passed, detail = null, { blocking = true } = {}) {
    return { key, label: CHECK_LABELS[key] || key, passed: Boolean(passed), detail, blocking };
  }

  /** Registration-number-only check (demo onboarding without a document). */
  checkRegistrationNo({ registrationNo, profileRegistrationNo = null }) {
    const checks = [
      CertificateVerificationService.check(
        'registration.format',
        REGISTRATION_RE.test(String(registrationNo || '').trim().toUpperCase()),
        `“${String(registrationNo || '').trim() || '(empty)'}”`,
      ),
    ];
    if (profileRegistrationNo) {
      checks.push(
        CertificateVerificationService.check(
          'registration.matches_profile',
          stripToCompare(registrationNo) === stripToCompare(profileRegistrationNo),
          `on file: ${String(profileRegistrationNo).trim()}`,
        ),
      );
    }
    const failed = checks.filter((c) => c.blocking && !c.passed);
    return {
      status: failed.length === 0 ? 'verified' : 'rejected',
      method: 'registration_no_only',
      ref: `CERT-REG-${stripToCompare(registrationNo) || 'UNKNOWN'}`,
      checks,
      reason:
        failed.length === 0
          ? null
          : failed.map((c) => `${c.label}: ${c.detail || 'failed'}`).join(' · '),
      mode: 'mock',
    };
  }

  /**
   * Full check for an uploaded certificate.
   *
   * @returns {{status:'verified'|'rejected', method:'document_checked', ref, checks, reason, meta, extractedTextReturned:boolean}}
   */
  async verifyDocument({
    file,
    registrationNo,
    registrationCouncil = null,
    fullName = null,
    profileRegistrationNo = null,
  }) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new ValidationError(
        'Attach your medical council certificate (PDF, JPG or PNG) so we can check it.',
        [{ path: 'certificate', message: 'A certificate file is required' }],
      );
    }

    const mime = String(file.mimetype || '').toLowerCase();
    const bytes = file.buffer.length;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const ref = `CERT-${sha256.slice(0, 12).toUpperCase()}`;

    const checks = [
      CertificateVerificationService.check('certificate.present', true, file.originalname || 'certificate'),
      CertificateVerificationService.check(
        'certificate.type',
        ALLOWED_MIME.has(mime),
        ALLOWED_MIME.has(mime) ? mime : `${mime || 'unknown type'} is not a PDF, image or text file`,
      ),
      CertificateVerificationService.check(
        'certificate.size',
        bytes <= this.maxBytes,
        `${Math.round(bytes / 1024)} KB (limit ${Math.round(this.maxBytes / 1024 / 1024)} MB)`,
      ),
      CertificateVerificationService.check(
        'registration.format',
        REGISTRATION_RE.test(String(registrationNo || '').trim().toUpperCase()),
        `“${String(registrationNo || '').trim() || '(empty)'}”`,
      ),
    ];

    if (profileRegistrationNo) {
      checks.push(
        CertificateVerificationService.check(
          'registration.matches_profile',
          stripToCompare(registrationNo) === stripToCompare(profileRegistrationNo),
          `on file: ${String(profileRegistrationNo).trim()}`,
        ),
      );
    }

    const blockingFailure = checks.some((c) => c.blocking && !c.passed);
    let extractedText = null;
    let textReadable = false;

    if (!blockingFailure && this.ocr) {
      try {
        const out = await this.ocr.extractText({ buffer: file.buffer, mimeType: mime });
        extractedText = String(out?.text || '');
        textReadable = extractedText.trim().length >= 20;
      } catch (err) {
        // Image OCR needs vendored language data; when it is missing we say so
        // instead of pretending the document was read.
        extractedText = null;
        textReadable = false;
      }
    }

    if (textReadable) {
      const haystack = stripToCompare(extractedText);
      const needle = stripToCompare(registrationNo);
      checks.push(
        CertificateVerificationService.check(
          'certificate.text_readable',
          // Never echo the document's text back into a stored record: the
          // certificate stays out of the database entirely (only its sha256).
          true,
          `${extractedText.replace(/\s+/g, ' ').trim().length} characters read`,
        ),
      );
      checks.push(
        CertificateVerificationService.check(
          'certificate.number_found',
          Boolean(needle) && haystack.includes(needle),
          Boolean(needle) && haystack.includes(needle)
            ? `found ${String(registrationNo).trim()} on the document`
            : `${String(registrationNo).trim() || 'the number'} was not found in the text we read`,
        ),
      );
      const nameTokens = String(fullName || '')
        .split(/[^A-Za-z0-9]+/)
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length >= 4);
      if (nameTokens.length) {
        const found = nameTokens.some((t) => haystack.includes(t));
        checks.push(
          CertificateVerificationService.check('certificate.name_found', found, found ? null : 'your name was not spotted on the document', {
            blocking: false,
          }),
        );
      }
    } else {
      checks.push(
        CertificateVerificationService.check('certificate.text_readable', false, 'the text could not be read automatically (manual review recommended)', {
          blocking: false,
        }),
      );
    }

    const failed = checks.filter((c) => c.blocking && !c.passed);
    const status = failed.length === 0 ? 'verified' : 'rejected';
    return {
      status,
      method: 'document_checked',
      mode: 'mock',
      ref,
      checks,
      reason:
        failed.length === 0
          ? null
          : failed.map((c) => `${c.label}: ${c.detail || 'failed'}`).join(' · '),
      meta: {
        sha256,
        fileName: file.originalname || null,
        mime: mime || null,
        bytes,
        textReadable,
        registrationCouncil: registrationCouncil || null,
      },
    };
  }
}
