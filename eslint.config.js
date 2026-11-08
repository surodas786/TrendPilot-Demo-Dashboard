import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/.next/**', 'apps/demo/**', '**/next-env.d.ts', 'test-results/**', 'playwright-report/**', 'packages/db/migrations/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    // Tests read loosely typed JSON response bodies.
    files: ['**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  }
);
