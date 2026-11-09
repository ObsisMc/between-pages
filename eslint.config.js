import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Prototypes are a frozen behavior baseline (ADR-0006), not formal code.
  { ignores: ['prototypes/**', '**/node_modules/**', '**/dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Calendar days are strings that never change time zone (spaces-and-invitations D3):
    // only `day.ts` turns them into `Date`s for the calendar widget. `range.ts` predates
    // the calendar and does its own UTC day-number arithmetic.
    files: ['apps/web/src/sharing-range/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/sharing-range/day.ts', 'apps/web/src/sharing-range/range.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Calendar days are strings; build a Date only in sharing-range/day.ts.',
        },
      ],
    },
  },
);
