/**
 * Spreadsheet exports (FR-TS-013, FR-ATT-019 style) with formula-injection protection: any
 * text cell that a spreadsheet could read as a formula is prefixed with an apostrophe
 * (OWASP "CSV injection"), in CSV and XLSX alike. Numbers stay numeric.
 */
import ExcelJSModule from 'exceljs';

export type Cell = string | number | null;

const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

export function safeText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function csvCell(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'number') return Number.isFinite(c) ? String(c) : '';
  const s = safeText(c);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with CRLF line ends and a UTF-8 BOM (so Excel reads names correctly). */
export function toCsv(header: string[], rows: Cell[][]): string {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const ExcelJS = (ExcelJSModule as unknown as { default?: typeof ExcelJSModule }).default ?? ExcelJSModule;

export async function toXlsx(sheetName: string, header: string[], rows: Cell[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  const guard = (c: Cell): string | number | null => (typeof c === 'string' ? safeText(c) : c);
  ws.addRow(header.map((h) => safeText(h)));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r.map(guard));
  ws.columns.forEach((col) => {
    col.width = 18;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- PDF (FR-REP-006)

/**
 * A simple paginated table as PDF (pdf-lib, already used for watermarking). Text only, A4
 * landscape, Helvetica; long cells are clipped, so column headers stay aligned. Formula
 * protection does not apply (nothing evaluates a PDF), but control characters are removed.
 */
export async function toPdf(title: string, subtitle: string, header: string[], rows: Cell[][]): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = [841.89, 595.28];
  const margin = 36;
  const size = 8;
  const rowH = 14;
  const colW = (W - 2 * margin) / Math.max(1, header.length);
  const clean = (v: Cell): string => (v === null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' '));
  const fit = (text: string, f: typeof font): string => {
    let t = text;
    while (t.length > 1 && f.widthOfTextAtSize(t, size) > colW - 6) t = `${t.slice(0, -2)}…`;
    return t;
  };
  let page = doc.addPage([W, H]);
  let y = H - margin;
  const drawHeader = () => {
    page.drawText(title, { x: margin, y, size: 14, font: bold });
    y -= 16;
    page.drawText(subtitle, { x: margin, y, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
    y -= 18;
    header.forEach((h, i) => page.drawText(fit(clean(h), bold), { x: margin + i * colW + 3, y, size, font: bold }));
    y -= 4;
    page.drawLine({ start: { x: margin, y }, end: { x: W - margin, y }, thickness: 0.8 });
    y -= rowH - 4;
  };
  drawHeader();
  for (const r of rows) {
    if (y < margin + rowH) {
      page = doc.addPage([W, H]);
      y = H - margin;
      drawHeader();
    }
    r.forEach((c, i) => page.drawText(fit(clean(c), font), { x: margin + i * colW + 3, y, size, font }));
    y -= rowH;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, { x: margin, y: 18, size: 7, font, color: rgb(0.45, 0.45, 0.45) }));
  return Buffer.from(await doc.save());
}
