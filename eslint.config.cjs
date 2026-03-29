// eslint.config.cjs — CommonJS flat config for ESLint v9
// (keeps the project's CommonJS module system intact)
const js = require('@eslint/js');

module.exports = [
    {
        ignores: ['node_modules/**', 'public/**'],
    },
    {
        ...js.configs.recommended,
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                process: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                Buffer: 'readonly',
            },
        },
        rules: {
            // Errors
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_|next|err',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-undef': 'error',
            'no-console': 'off',

            // Best practices
            'eqeqeq': ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'warn',
            'no-duplicate-imports': 'error',

            // Style (warn, not error)
            'semi': ['warn', 'always'],
            'quotes': ['warn', 'single', { avoidEscape: true }],
        },
    },
];
