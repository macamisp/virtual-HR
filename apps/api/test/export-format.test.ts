/**
 * FR-TS-013 exports: CSV/XLSX with formula-injection protection (OWASP CSV injection),
 * written before the implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJSModule from 'exceljs';
import { safeText, toCsv, toXlsx } from '../src/common/export-format.ts';

const ExcelJS = (ExcelJSModule as unknown as { default?: typeof ExcelJSModule }).default ?? ExcelJSModule;

describe('safeText', () => {
  it('neutralises every formula trigger, including full-width variants', () => {
    for (const bad of ['=1+1', '+1', '-1+1', '@SUM(A1)', '\t=1', '\r=1', '＝1+1', '＋1', '－1', '＠x', '=HYPERLINK("http://evil","x")']) {
      assert.equal(safeText(bad), `'${bad}`, JSON.stringify(bad));
    }
  });
  it('leaves ordinary text alone', () => {
    for (const ok of ['Sam Subcontractor', 'a=b', '2026-10-12', '', 'R&D']) assert.equal(safeText(ok), ok);
  });
});

describe('toCsv', () => {
  it('quotes and escapes, keeps numbers numeric, guards text, uses CRLF and a BOM', () => {
    const csv = toCsv(['Name', 'Hours', 'Note'], [
      ['=cmd|" /C calc"!A0', 1.5, 'a,b'],
      ['Line\nbreak', -2, 'say "hi"'],
      [null, 0, '-not a number'],
    ]);
    assert.ok(csv.startsWith('﻿'));
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], 'Name,Hours,Note');
    assert.equal(lines[1], `"'=cmd|"" /C calc""!A0",1.5,"a,b"`);
    assert.equal(lines[2], '"Line\nbreak",-2,"say ""hi"""', 'embedded newlines stay inside the quoted cell');
    assert.ok(csv.includes(`,0,'-not a number`));
  });
});

describe('toXlsx', () => {
  it('writes a real workbook: numbers as numbers, text guarded, never a formula', async () => {
    const buf = await toXlsx('Report', ['Name', 'Hours'], [['=1+1', 2.25], ['Ann', -1]]);
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Report')!;
    assert.equal(ws.getCell('A1').value, 'Name');
    assert.equal(ws.getCell('A2').value, "'=1+1");
    assert.equal(ws.getCell('B2').value, 2.25);
    assert.equal(ws.getCell('B3').value, -1);
    ws.eachRow((row) => row.eachCell((cell) => assert.notEqual(cell.type, ExcelJS.ValueType.Formula)));
  });
});
