import { SetMetadata } from '@nestjs/common';

/** Marks a route as callable with an MFA-enrollment token (in addition to a full access token). FR-AUTH-004. */
export const ALLOW_MFA_ENROLLMENT_KEY = 'allowMfaEnrollment';
export const AllowMfaEnrollment = () => SetMetadata(ALLOW_MFA_ENROLLMENT_KEY, true);
