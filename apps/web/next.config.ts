import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Самодостаточная сборка для Docker (правило переносимости): сервер запускается командой node server.js.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  poweredByHeader: false,
};

export default config;
