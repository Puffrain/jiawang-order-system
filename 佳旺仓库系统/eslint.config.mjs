import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Next 15 generates a triple-slash route type reference in this file;
    // it is framework output rather than application code and should not
    // make a clean lint run fail.
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'data/**', 'next-env.d.ts']
  }
];

export default config;
