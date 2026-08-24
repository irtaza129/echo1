import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  // env is still loaded so other plugins can reference it if needed;
  // GEMINI_API_KEY is intentionally NOT injected here. The browser never sees
  // the real key at all — it POSTs /api/gemini-token and gets a 60-second
  // ephemeral token back, so the key stays inside the Node process.
  loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        // Two entry points, on purpose.
        //
        // index.html is the staff app: kiosk, admin, and the till — which
        // includes order entry, tender, drawer counts and the manager-approval
        // flow. guest.html is a diner's phone.
        //
        // A diner must never be served that bundle. Not because the code is
        // secret, but because shipping the till to every phone that scans a QR
        // means every future POS screen becomes something an attacker can read
        // at leisure for hints about the API. Separate entries keep the two
        // apart at build time rather than relying on routing to hide one.
        input: {
          main:  path.resolve(__dirname, 'index.html'),
          guest: path.resolve(__dirname, 'guest.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
