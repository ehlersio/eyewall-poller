import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'module',
      globals: {
        // Cloudflare Workers globals
        fetch:    'readonly',
        Request:  'readonly',
        Response: 'readonly',
        URL:      'readonly',
        console:  'readonly',
        crypto:   'readonly',
        atob:     'readonly',
        btoa:     'readonly',
        TextEncoder:  'readonly',
        TextDecoder:  'readonly',
        performance:  'readonly',
        caches:       'readonly',
      },
    },
    rules: {
      'no-unused-vars':    ['warn', { argsIgnorePattern: '^_' }],
      'no-console':         'off',
      'no-undef':           'error',
      'prefer-const':       'warn',
      'no-duplicate-case':  'error',
    },
  },
  {
    ignores: ['node_modules/', '.wrangler/', 'dist/'],
  },
];
