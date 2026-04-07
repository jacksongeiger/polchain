import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Allow imports from server/addresses.json (one level above frontend root)
  // so the build-time address fallback in contracts.js stays in sync with the
  // single source of truth.
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
