import { toString as qrToString, type QRCodeToStringOptions } from 'qrcode';

/** Fixed dark-on-light colours: authenticator apps scan these reliably in both themes. */
export const OTPAUTH_QR_OPTIONS: QRCodeToStringOptions = {
  type: 'svg',
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 192,
  color: { dark: '#000000', light: '#ffffff' },
};

/**
 * QR code for an otpauth:// URI as an SVG data URL, generated entirely in the browser:
 * the TOTP secret never leaves the page. SVG output is deterministic, so tests can
 * regenerate and compare it.
 */
export async function otpauthQrDataUrl(otpauthUrl: string): Promise<string> {
  const svg = await qrToString(otpauthUrl, OTPAUTH_QR_OPTIONS);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
