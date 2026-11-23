'use strict';
const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', '.tools/**', 'release/**'] },
  {
    files: ['src/**/*.js', 'tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, Buffer: 'readonly', process: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-const-assign': 'error', 'no-redeclare': 'error', 'no-import-assign': 'error' },
  },
  {
    files: ['electron/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node, window: 'readonly', document: 'readonly', getComputedStyle: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-const-assign': 'error' },
  },
];
