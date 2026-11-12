import { startBot } from './src/index.js';

startBot().catch((err) => {
  console.error('[Midwave] Fatal startup error:', err.message);
  process.exit(1);
});
