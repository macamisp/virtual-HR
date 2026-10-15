// ESLint flat config for apps/api and packages/shared (apps/web has its own config).
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'apps/web/**'] },
  {
    files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      // AGENTS.md: no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
);
