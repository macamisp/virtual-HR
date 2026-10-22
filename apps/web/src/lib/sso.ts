'use client';

import { GoogleStartResponseSchema } from '@hrvo/shared';
import type { GoogleResultCode, GoogleStartDto } from '@hrvo/shared';
import { apiFetch } from './api';

/** Starts "Continue with Google": the API answers with Google's URL and sets the state cookie. */
export async function startGoogleSignIn(dto: GoogleStartDto): Promise<void> {
  const r = await apiFetch('/auth/google/start', { method: 'POST', auth: 'none', body: dto, schema: GoogleStartResponseSchema });
  window.location.assign(r.authorizeUrl);
}

const MESSAGES: Record<GoogleResultCode, string> = {
  ok: '',
  totp: '',
  enroll: '',
  linked: '',
  email_mismatch: 'That Google account uses a different e-mail address than the invitation. Sign in with the invited address.',
  no_account: 'No HRVO account uses that Google address. Ask for an invitation, or create a workspace.',
  unverified_email: 'Google has not verified that e-mail address. Verify it with Google first.',
  denied: 'Google did not sign you in: you cancelled, or the app is still in Testing mode in Google Cloud Console and your address is not one of its test users (ask the administrator to add it, or publish the app).',
  invalid_state: 'The sign-in attempt expired or was tampered with. Please try again.',
  failed: 'Google sign-in did not complete. Please try again.',
  token_invalid: 'Google\'s answer could not be verified (wrong or expired token). Please try again; if it keeps happening, the server clock or the Google client id may be wrong.',
  redirect_uri_mismatch: 'Google refused the redirect address: the redirect URI registered in Google Cloud Console does not match this server\'s GOOGLE_REDIRECT_URI. Run npm run google:check for the exact value.',
  already_linked: 'That Google account is already linked to another HRVO account.',
  choose_workspace: 'That address belongs to several workspaces. Sign in with your password to choose one, or enter the workspace below.',
  not_configured: 'Sign in with Google is not set up on this server.',
  account_inactive: 'This account is not active. Contact your administrator.',
  invitation_invalid: 'This invitation is no longer valid. Ask for a new one.',
};

export function ssoErrorMessage(code: string | null): string {
  return (code && (MESSAGES as Record<string, string>)[code]) || 'Google sign-in did not complete. Please try again.';
}
