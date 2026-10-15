/**
 * Minimal typings for the parts of `qrcode` 1.5 we use. Declared locally instead of adding
 * @types/qrcode (AGENTS.md: no unapproved packages).
 */
declare module 'qrcode' {
  export interface QRCodeToStringOptions {
    type?: 'svg' | 'utf8' | 'terminal';
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
    color?: { dark?: string; light?: string };
  }
  export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
}
