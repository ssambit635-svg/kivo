/**
 * Minimal digital-PDF fixture: a hand-built, dependency-free PDF whose content
 * stream carries lab-report text as literal + hex strings — exactly what a
 * computer-generated lab PDF looks like to the PdfTextOcrProvider.
 */
export function buildDigitalPdf() {
  const lines = [
    'Hemoglobin 13.4 g/dL 12.0 - 15.5',
    'Glucose Fasting 126 mg/dL 70 - 100',
    'HbA1c 6.1 % 4.0 - 5.6',
  ];
  // One text row per content-stream line, as line-oriented generators emit.
  const content = [...lines.map((l) => `(${escapePdf(l)}) Tj`), '<476C75636F736520546F74616C> Tj'].join('\n'); // hex for "Glucose Total"
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join('\n')}\n%%EOF`, 'latin1');
}

function escapePdf(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
