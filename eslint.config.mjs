import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // Playwright fixtures call a parameter named `use`, which the React hooks rule mistakes for
    // React's use() hook.
    files: ['e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' }
  },
  {
    // The Steam modules that are pure functions of their input: the e2e specs load them in plain
    // Node and the chunk worker loads them in a worker thread, neither of which has Electron's
    // `app` (which testKnobs reads as it loads) or resolves electron-vite's `?` imports.
    files: [
      'src/main/steam/{appInfo,backend,cells,chunkCodec,crypto,eresult,layout,libraryFolders,lzma,manifest,redact,scheduler,servers,zip}.ts'
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['electron'],
          patterns: ['**/testKnobs', '*\\?*']
        }
      ]
    }
  },
  {
    // Plain JavaScript that node runs as-is, so TypeScript's conventions (return types, import
    // syntax) don't apply.
    files: ['scripts/**/*.{mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  eslintConfigPrettier
)
