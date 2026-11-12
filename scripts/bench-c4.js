import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  chooseConnect4Move,
  createEmptyConnect4Board,
  findDropRow,
} from '../src/games/ai/connectFourAI.js';
import { createSeededRng } from '../src/utils/random.js';

function buildBoardFromMoves(cols) {
  const board = createEmptyConnect4Board();
  let mark = 1;
  for (const c of cols) {
    const r = findDropRow(board, c);
    if (r !== -1) {
      board[r][c] = mark;
      mark = mark === 1 ? 2 : 1;
    }
  }
  return board;
}

const TEST_BOARDS = [
  { name: 'Empty Board', board: createEmptyConnect4Board() },
  { name: 'Early Opening (4 moves)', board: buildBoardFromMoves([3, 3, 2, 4]) },
  {
    name: 'Midgame Complex (14 moves)',
    board: buildBoardFromMoves([3, 2, 3, 4, 2, 3, 4, 2, 1, 5, 3, 4, 1, 5]),
  },
  {
    name: 'Dense Midgame (22 moves)',
    board: buildBoardFromMoves([3, 3, 2, 4, 2, 2, 4, 4, 1, 5, 1, 5, 0, 6, 3, 2, 5, 1, 6, 0, 4, 1]),
  },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function runBenchForConfig(maxDepth, timeBudgetMs, iterations = 15) {
  const rng = createSeededRng(2026);
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();

  const latencies = [];
  for (let i = 0; i < iterations; i += 1) {
    for (const item of TEST_BOARDS) {
      // Yield to event loop between AI calls to measure realistic tick delay
      await new Promise((resolve) => setTimeout(resolve, 1));
      const start = performance.now();
      const col = chooseConnect4Move(item.board, 'hard', 2, rng, {
        maxDepth,
        timeBudgetMs,
      });
      const elapsed = performance.now() - start;
      if (col < 0 || col > 6) {
        throw new Error(`Invalid AI move ${col} on ${item.name}`);
      }
      latencies.push(elapsed);
    }
  }

  histogram.disable();
  latencies.sort((a, b) => a - b);

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p95 = percentile(latencies, 95);
  const max = latencies[latencies.length - 1];
  const eventLoopP95Ms = histogram.percentile(95) / 1e6;
  const eventLoopMaxMs = histogram.max / 1e6;

  return {
    maxDepth,
    timeBudgetMs,
    samples: latencies.length,
    avgMs: Number(avg.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    maxMs: Number(max.toFixed(2)),
    eventLoopP95Ms: Number(eventLoopP95Ms.toFixed(2)),
    eventLoopMaxMs: Number(eventLoopMaxMs.toFixed(2)),
  };
}

console.log('=== Connect Four AI Benchmark ===');
console.log('Target: move p95 < 100 ms, event loop delay p95 < 50 ms\n');

const configs = [
  { maxDepth: 4, timeBudgetMs: 50 },
  { maxDepth: 5, timeBudgetMs: 50 },
  { maxDepth: 6, timeBudgetMs: 50 },
  { maxDepth: 7, timeBudgetMs: 50 },
];

const results = [];
for (const c of configs) {
  results.push(await runBenchForConfig(c.maxDepth, c.timeBudgetMs));
}
console.table(results);
