export default {
  content: [
  './index.html',
  './src/**/*.{js,ts,jsx,tsx}'
],
  theme: {
    extend: {
      colors: {
        canvas: '#0B1220',
        surface: '#111A2E',
        inset: '#0D1526',
        raised: '#16213A',
        line: '#1E2A44',
        'line-strong': '#2A3A5C',
        ink: '#E2E8F0',
        muted: '#94A3B8',
        subtle: '#8291A8',
        accent: { DEFAULT: '#2DD4BF', ink: '#06201C' },
        gain: '#22C55E',
        loss: '#F43F5E',
        warn: '#F5B342',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
};
