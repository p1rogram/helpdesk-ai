import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Standalone Node/browser-context utility scripts (crawlers) - not part of the app build.
    files: ['scripts/**/*.mjs', 'deploy/**/*.mjs', 'deploy/**/*.worker.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-unused-expressions': 'off', 'no-irregular-whitespace': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
);
