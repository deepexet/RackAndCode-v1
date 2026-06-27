import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  publicDir: 'public',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index.html',
      output: {
        // Code splitting by module
        manualChunks: {
          'core':      ['./src/core/api.js', './src/core/router.js', './src/core/store.js'],
          'projects':  ['./src/modules/projects.js'],
          'inventory': ['./src/modules/inventory.js'],
          'admin':     ['./src/modules/admin.js'],
          'tech':      ['./src/modules/tech.js'],
        },
      },
    },
    // Target modern browsers only (we control the deployment environment)
    target: 'es2022',
    sourcemap: true,
  },

  server: {
    port: 5173,
    // Proxy API calls to FastAPI backend in development
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
    },
  },

  preview: {
    port: 5173,
  },
})
