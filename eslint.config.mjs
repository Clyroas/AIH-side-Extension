// Lint baseline for the extension. Every file is a plain ES module or a classic content script that Chrome
// loads directly — there is no build step and no framework — so this config exists only to catch mistakes
// that would break the panel at runtime: undefined identifiers, dead code, duplicate keys, unawaited work.
const browser = {
  window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly', history: 'readonly',
  console: 'readonly', crypto: 'readonly', globalThis: 'readonly', self: 'readonly', performance: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', queueMicrotask: 'readonly',
  structuredClone: 'readonly', atob: 'readonly', btoa: 'readonly', fetch: 'readonly', getComputedStyle: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
  FormData: 'readonly', DataTransfer: 'readonly', DragEvent: 'readonly', Image: 'readonly', DOMParser: 'readonly',
  CustomEvent: 'readonly', Event: 'readonly', KeyboardEvent: 'readonly', MouseEvent: 'readonly',
  PointerEvent: 'readonly', ClipboardEvent: 'readonly', InputEvent: 'readonly', TextEncoder: 'readonly',
  TextDecoder: 'readonly', AbortController: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly', Node: 'readonly', NodeFilter: 'readonly', Element: 'readonly',
  HTMLElement: 'readonly', HTMLInputElement: 'readonly', HTMLTextAreaElement: 'readonly',
  HTMLDialogElement: 'readonly', Range: 'readonly', CSS: 'readonly', OffscreenCanvas: 'readonly',
  createImageBitmap: 'readonly', localStorage: 'readonly', indexedDB: 'readonly', caches: 'readonly',
  innerHeight: 'readonly', innerWidth: 'readonly', scrollTo: 'readonly', scrollY: 'readonly'
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'no-redeclare': 'error',
  'no-self-assign': 'error',
  'no-unused-private-class-members': 'error',
  'no-async-promise-executor': 'error',
  'no-promise-executor-return': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-compare-neg-zero': 'error',
  'no-obj-calls': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-setter-return': 'error',
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': 'error',
  'no-sparse-arrays': 'error',
  'no-control-regex': 'error',
  'no-template-curly-in-string': 'warn',
  'array-callback-return': 'error',
  'require-atomic-updates': 'off',
  'valid-typeof': 'error',
  'use-isnan': 'error'
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'icons/**'] },
  {
    files: ['*.js', 'dev/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...browser, chrome: 'readonly' } },
    rules
  },
  {
    // The service worker: same rules, but there is no DOM to reach for.
    files: ['worker.js'],
    languageOptions: { globals: { ...browser, document: 'off', window: 'off' } }
  },
  {
    // The test suite and the dev scripts run in Node, not in the browser.
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', setImmediate: 'readonly', clearImmediate: 'readonly', global: 'readonly',
        Buffer: 'readonly', URL: 'readonly', console: 'readonly', crypto: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly'
      }
    },
    rules
  }
];
