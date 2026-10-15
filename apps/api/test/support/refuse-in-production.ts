/**
 * Import this FIRST in any demo/seed script. ES modules evaluate imports in order, so
 * this runs before any other module (or database connection) of the script.
 * Seeds delete and insert fixed demo tenants; they must never touch a production database.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run demo/seed script with NODE_ENV=production.');
  process.exit(1);
}

export {};
