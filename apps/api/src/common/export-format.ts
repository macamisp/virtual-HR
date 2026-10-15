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
