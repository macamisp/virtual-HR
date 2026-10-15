/** Client-side mirror of FR-AUTH-002's length rule; the breach check happens on the server. */
export function passwordProblems(password: string, confirm: string): { password?: string; confirm?: string } {
  const out: { password?: string; confirm?: string } = {};
  if (password.length < 12) out.password = 'Use at least 12 characters.';
  else if (password.length > 128) out.password = 'Use at most 128 characters.';
  if (confirm !== password) out.confirm = 'Passwords do not match.';
  return out;
}
