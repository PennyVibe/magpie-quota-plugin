import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'node_modules/**', 'dist/**', 'generated/**', 'coverage/**',
    'outputs/**', 'work/**', '.agents/**', '.codex/**',
  ]),
  {
    files: ['local/**/*.{ts,tsx}', 'lib/**/*.ts', 'widget/**/*.ts', 'tests/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Browser/host mocks intentionally stand in for jsdom's dynamic objects.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'local/*.cjs', 'eslint.config.mjs'],
    rules: {
      'no-unreachable': 'error', 'no-constant-condition': 'error',
      'valid-typeof': 'error', 'eqeqeq': ['error', 'always'],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]);
