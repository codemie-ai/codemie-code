import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const SSO_AUTH_MESSAGE =
  'Resolve SSO credentials via @/providers/plugins/sso/auth (resolveSSOAuth & co); do not inspect credential shape outside the SSO auth module.';

export default [
  eslint.configs.recommended,
  // Test files without project requirement (must come first to match before src/**/*.ts)
  {
    files: ['tests/**/*.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'warn',
      'no-undef': 'off',
      'no-useless-catch': 'warn',
      'no-case-declarations': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  // Source files with type-aware linting
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'warn',
      'no-undef': 'off', // TypeScript handles this
      'no-useless-catch': 'warn',
      'no-case-declarations': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  // SSO credential shape is decided in one place. Everything outside the SSO auth module resolves
  // credentials through `resolveSSOAuth` & co instead of touching the store or sniffing the shape.
  // Allowed: src/utils/security.ts (the credential store), the SSO auth module, the JWT provider
  // (it owns bearer-auth profile tokens) and tests.
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/utils/security.ts',
      'src/providers/plugins/sso/auth/**',
      'src/providers/plugins/jwt/**',
      'src/**/*.test.ts',
      '**/__tests__/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name=/^(retrieve|store|clear)(SSO|JWT)Credentials$/]',
          message: SSO_AUTH_MESSAGE,
        },
        {
          selector: "BinaryExpression[operator='in'][left.value=/^(cookies|token|jwtToken)$/]",
          message: SSO_AUTH_MESSAGE,
        },
      ],
    },
  },
  // Pi loads this asset in its own process, where a syntax error makes Pi exit(1) and
  // take the user's session with it. It is plain ESM JavaScript (tsc must not compile
  // it), so it needs an explicit block — the blanket '**/*.js' ignore below would
  // otherwise leave the one file that most needs checking entirely unlinted.
  {
    files: ['src/agents/plugins/pi/extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/*.js',
      '!src/agents/plugins/pi/extension/**/*.js',
    ],
  },
];
