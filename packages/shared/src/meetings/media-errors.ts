/**
 * Plain-language reasons why the camera or microphone could not start (FR-MEET-011). Browsers
 * expose camera and microphone only in a secure context: HTTPS, or http://localhost. On a plain
 * http:// address (a LAN IP, or a tunnel without TLS) navigator.mediaDevices is missing or every
 * request fails, so that case is named first: no permission setting can fix it.
 */
export type MediaDevice = 'camera' | 'microphone' | 'camera or microphone';

export interface MediaContext {
  /** window.isSecureContext */
  secure: boolean;
  /** navigator.mediaDevices exists */
  hasMediaDevices: boolean;
  /** window.location.origin, shown so the person can see which address they opened */
  origin: string;
}

export function mediaErrorMessage(err: unknown, device: MediaDevice, ctx: MediaContext): string {
  if (!ctx.secure || !ctx.hasMediaDevices) {
    return `The ${device} only works on a secure connection. This page is open at ${ctx.origin}, which is not HTTPS, so the browser does not offer the ${device} at all (no permission setting changes that). Open the HTTPS address of HRVO, or http://localhost on the computer that runs it. To set up HTTPS for other devices, follow the guide docs/runbooks/lan-https.md.`;
  }
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return `The browser blocked the ${device}. Allow it for this site (the icon left of the address bar), then try again.`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return `No ${device} was found. Connect one, or choose another device below.`;
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return `The ${device} is in use by another application or could not be started. Close the other application and try again.`;
    default:
      return `The ${device} could not be started.`;
  }
}
