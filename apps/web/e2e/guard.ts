/** E2E seeding deletes and re-creates a tenant; never allow it against production. */
export function ADMIN_GUARD(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run e2e seeding with NODE_ENV=production');
  }
}
