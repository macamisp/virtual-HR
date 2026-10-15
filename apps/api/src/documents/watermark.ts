/**
 * FR-DOC-011 view-only mode: the file is re-rendered with a dynamic watermark (viewer, time,
 * IP) on every page, server-side, so the bytes that reach the browser always carry it.
 * PDFs are stamped; PNG and JPEG are placed on a one-page PDF and stamped. Anything that
 * cannot be stamped is refused rather than served unmarked.
 */
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

/** Standard PDF fonts are WinAnsi: keep the watermark to printable Latin-1. */
function printable(text: string): string {
  return text.replace(/[·•]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

function stamp(page: PDFPage, font: PDFFont, text: string): void {
  const { width, height } = page.getSize();
  const size = Math.max(10, Math.min(width, height) / 28);
  const color = rgb(0.75, 0.1, 0.1);
  // A diagonal grid across the page, plus a solid line at the bottom.
  for (let y = -height; y < height * 2; y += size * 9) {
    for (let x = -width; x < width * 2; x += font.widthOfTextAtSize(text, size) + size * 6) {
      page.drawText(text, { x, y, size, font, color, opacity: 0.22, rotate: degrees(30) });
    }
  }
  page.drawText(text, { x: 12, y: 10, size: Math.max(7, size * 0.6), font, color, opacity: 0.85 });
}

export async function watermarkPdf(pdf: Uint8Array, text: string): Promise<Uint8Array> {
  // Encrypted PDFs are refused: their pages cannot be stamped reliably.
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: false, updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const line = printable(text);
  const pages = doc.getPages();
  if (pages.length === 0) throw new Error('The PDF has no pages');
  for (const page of pages) stamp(page, font, line);
  doc.setProducer('HRVO view-only');
  return await doc.save();
}

export async function watermarkImageAsPdf(image: Uint8Array, mimeType: string, text: string): Promise<Uint8Array> {
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') throw new Error(`View-only mode is not supported for ${mimeType}`);
  const doc = await PDFDocument.create();
  const img = mimeType === 'image/png' ? await doc.embedPng(image) : await doc.embedJpg(image);
  // Fit within A4 at 72 dpi while keeping the aspect ratio (tiny images are scaled up).
  const scale = Math.min(595 / img.width, 842 / img.height);
  const page = doc.addPage([Math.max(200, img.width * scale), Math.max(200, img.height * scale)]);
  page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  stamp(page, await doc.embedFont(StandardFonts.HelveticaBold), printable(text));
  doc.setProducer('HRVO view-only');
  return await doc.save();
}
