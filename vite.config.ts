import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, loadEnv } from 'vite';

// The phone app. `npm run dev` serves it over HTTPS with a self-signed certificate
// (phones only allow the microphone on secure pages) and forwards /ws to the relay server.
export default defineConfig(({ mode }) => {
  // Only to find the relay server's port; nothing from .env reaches the browser.
  const serverPort = loadEnv(mode, import.meta.dirname, '')['PORT'] || '8787';
  return {
    root: 'client',
    plugins: [basicSsl({ name: 'earbridge-dev' })],
    server: {
      host: true, // reachable from phones on the same Wi-Fi
      port: 5173,
      strictPort: true,
      allowedHosts: ['.local'], // e.g. https://my-laptop.local:5173
      proxy: {
        // No changeOrigin: the relay checks the page's Origin against this Host header.
        '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
