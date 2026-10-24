import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  routeRequest, setRoutingStrategy, refreshStatsCache,
} from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';
import * as ratelimit from '../../services/ratelimit.js';
import type { TaskBias } from '../../lib/task-type.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// Same seed shape as router-bandit.test.ts, plus a configurable speed_rank so
// the two fixture models differ on BOTH axes (intelligence and speed).
function addModel(opts: {
  platform: string; modelId: string; name: string;
  intelligenceRank: number; speedRank: number; sizeLabel: string; budget: string; priority: number;
  supportsVision?: boolean;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1)
  `).run(opts.platform, opts.modelId, opts.name, opts.intelligenceRank, opts.speedRank, opts.sizeLabel, opts.budget, opts.supportsVision ? 1 : 0);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(opts.platform, opts.modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, opts.priority);
  addToActiveChain(id, opts.priority);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(opts.platform);
  return id;
}

function addHistory(platform: string, modelId: string, opts: {
  successes: number; failures: number; outTokens?: number; latencyMs?: number; ttfbMs?: number | null;
}) {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?)
  `);
  for (let i = 0; i < opts.successes; i++) {
    ins.run(platform, modelId, 'success', opts.outTokens ?? 100, opts.latencyMs ?? 1000, null, opts.ttfbMs ?? null);
  }
  for (let i = 0; i < opts.failures; i++) {
    ins.run(platform, modelId, 'error', 0, opts.latencyMs ?? 1000, 'boom', opts.ttfbMs ?? null);
  }
}

function pickCounts(runs: number, task?: TaskBias, requireVision = false): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100, undefined, undefined, requireVision, false, undefined, undefined, false, undefined, 0, task);
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
  }
  return counts;
}

// The intelligence axis is min-max normalized to 1/0 across a two-model chain,
// so the code bias (0.325 intelligence) wins by ~0.15 score over the speed
// axis and the chat bias flips it the other way. Assert DIRECTION (not a fixed
// ratio) with enough runs that the ~55/45 split is well past noise.
const TASK_RUNS = 400;

// Fixture: A ("smart") is the smarter but much slower model, B ("fast") the
// weaker but blazing-fast one. Equal reliability (all successes) and equal
// budgets, so the only differing axes are intelligence (A > B — rank 1 is the
// catalog's best) and speed (B >> A). The speed gap is intentionally extreme:
// intelligenceScore is min-max normalized across the chain, so with two models
// it is always 1 vs 0, and the speed axis must out-weigh that for the chat
// bias to flip the pick.
function seedSmartVsFast() {
  addModel({ platform: 'google', modelId: 'smart', name: 'Smart', intelligenceRank: 1, speedRank: 9, sizeLabel: 'Large', budget: '~50M', priority: 1 });
  addModel({ platform: 'groq', modelId: 'fast', name: 'Fast', intelligenceRank: 2, speedRank: 1, sizeLabel: 'Large', budget: '~50M', priority: 2 });
  addHistory('google', 'smart', { successes: 100, failures: 0, outTokens: 1, latencyMs: 60000, ttfbMs: 4999 });
  addHistory('groq', 'fast', { successes: 100, failures: 0, outTokens: 10000, latencyMs: 100, ttfbMs: 10 });
}

describe('task-type-aware routing', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('is off by default: no task argument splits the two axes evenly', () => {
    seedSmartVsFast();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS);
    // Balanced weights (0.25/0.25) make A and B comparable; neither axis dominates.
    expect(counts['smart'] ?? 0).toBeGreaterThan(0);
    expect(counts['fast'] ?? 0).toBeGreaterThan(0);
  });

  it('code tasks bias toward the smarter (slower) model', () => {
    seedSmartVsFast();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS, 'code');
    expect(counts['smart'] ?? 0).toBeGreaterThan(counts['fast'] ?? 0);
  });

  it('chat tasks bias toward the faster (weaker) model', () => {
    seedSmartVsFast();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS, 'chat');
    expect(counts['fast'] ?? 0).toBeGreaterThan(counts['smart'] ?? 0);
  });

  // Same fixture, but the fast model is now visibly less reliable, which puts
  // `fastest`'s pick close enough to the edge that the code bias WOULD flip it
  // (0.55/0.10 speed/intelligence becomes 0.385/0.265). It must not: `fastest`,
  // `reliable` and `custom` are the operator's explicit choice of where on the
  // axis to sit, so a per-request header does not get to rewrite them (#1127).
  // The other two exempt strategies are covered exactly in scoring.test.ts.
  function seedSmartVsFlakyFast() {
    addModel({ platform: 'google', modelId: 'smart', name: 'Smart', intelligenceRank: 1, speedRank: 9, sizeLabel: 'Large', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'fast', name: 'Fast', intelligenceRank: 2, speedRank: 1, sizeLabel: 'Large', budget: '~50M', priority: 2 });
    addHistory('google', 'smart', { successes: 100, failures: 0, outTokens: 1, latencyMs: 60000, ttfbMs: 4999 });
    addHistory('groq', 'fast', { successes: 50, failures: 50, outTokens: 10000, latencyMs: 100, ttfbMs: 10 });
  }

  it('leaves the fastest preset alone on a code task', () => {
    seedSmartVsFlakyFast();
    setRoutingStrategy('fastest');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS, 'code');
    expect(counts['fast'] ?? 0).toBeGreaterThan(counts['smart'] ?? 0);
  });

  // Fixture for image turns: a text-only Frontier model that is the best (and
  // fast) model overall, a Medium vision model that is the strongest one that
  // can SEE but slow, and a Small vision model that is weak but blazing fast.
  // Normalized across the whole chain, the text-only model set the top of the
  // intelligence scale, so the Medium vision model scored 1/3 and the Small one
  // 0 — the speed axis decided the image turn. Normalized across the vision
  // models only, the strongest one that can actually serve scores 1.
  function seedTextVsVision() {
    addModel({ platform: 'google', modelId: 'frontier-text', name: 'Frontier Text', intelligenceRank: 1, speedRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addModel({ platform: 'mistral', modelId: 'vision-smart', name: 'Vision Smart', intelligenceRank: 1, speedRank: 9, sizeLabel: 'Medium', budget: '~50M', priority: 2, supportsVision: true });
    addModel({ platform: 'groq', modelId: 'vision-fast', name: 'Vision Fast', intelligenceRank: 1, speedRank: 1, sizeLabel: 'Small', budget: '~50M', priority: 3, supportsVision: true });
    addHistory('google', 'frontier-text', { successes: 100, failures: 0, outTokens: 10000, latencyMs: 100, ttfbMs: 10 });
    addHistory('mistral', 'vision-smart', { successes: 100, failures: 0, outTokens: 1, latencyMs: 60000, ttfbMs: 4999 });
    addHistory('groq', 'vision-fast', { successes: 100, failures: 0, outTokens: 10000, latencyMs: 100, ttfbMs: 10 });
  }

  it('an image turn goes to the strongest vision model, not the fastest', () => {
    seedTextVsVision();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    // What resolveTaskType returns for an image request with no header.
    const counts = pickCounts(TASK_RUNS, 'vision', true);
    expect(counts['frontier-text'] ?? 0).toBe(0);
    expect(counts['vision-smart'] ?? 0).toBeGreaterThan(counts['vision-fast'] ?? 0);
  });

  it('scales the intelligence axis to the vision models even without a task bias', () => {
    seedTextVsVision();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    // Whole-chain normalization gave vision-smart 1/3 intelligence against
    // vision-fast's full speed lead — a ~0.17 score gap Thompson noise never
    // closes, so it was picked essentially never. Scaled to the vision pool
    // the two axes balance, and it wins a real share of draws.
    const counts = pickCounts(TASK_RUNS, undefined, true);
    expect(counts['vision-smart'] ?? 0).toBeGreaterThan(TASK_RUNS * 0.2);
  });

  it('a text turn still goes to the strongest model overall', () => {
    seedTextVsVision();
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(TASK_RUNS);
    expect(counts['frontier-text'] ?? 0).toBeGreaterThan((counts['vision-smart'] ?? 0) + (counts['vision-fast'] ?? 0));
  });
});
