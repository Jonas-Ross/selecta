import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mjs,js}'],
    languageOptions: { globals: globals.node },
    rules: {
      // Dropping columns via rest destructuring is the row-projection idiom
      // (cache/queries.ts, tools/inspect_tracklist.ts); `_` args are unused
      // callback parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // Must stay last: turns off every stylistic rule so Prettier owns formatting.
  prettier,
);
