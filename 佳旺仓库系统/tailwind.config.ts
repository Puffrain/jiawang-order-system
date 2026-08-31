import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        ink: '#17212b',
        paper: '#f7f8fa',
        brand: '#0f766e'
      }
    }
  },
  plugins: []
};

export default config;
