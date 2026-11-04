// ESLint flat config for apps/web: Next.js core-web-vitals + TypeScript rules (ADR 006).
// eslint-config-next 15 ships legacy-format configs; FlatCompat (from ESLint's own
// @eslint/eslintrc) adapts them, as documented by Next.js for ESLint 9.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', '.next-e2e/**', '.next-demo/**', '.next-demo-internet/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // AGENTS.md: no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
];

export default config;
