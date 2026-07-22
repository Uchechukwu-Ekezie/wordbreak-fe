// Grid track progression + saved progress — the drag-to-connect sibling of lib/levels.ts.
// Deliberately a separate module with its own localStorage key rather than a generalized
// {track, level}-keyed rewrite of levels.ts: that would mean migrating live players' saved
// Rack progress, which is exactly the risk a parallel module avoids.

import { starsFor } from "./levels";

export type GridLevelDef = {
  level: number;
  gridSize: number; // 4 -> 6 as you climb (4x4 for L1-3, 5x5 L4-6, 6x6 L7+)
  goal: number;
  seconds: number;
};

export function gridLevelDef(level: number): GridLevelDef {
  return {
    level,
    gridSize: Math.min(4 + Math.floor((level - 1) / 3), 6),
    goal: 3 + (level - 1) * 4, // grids yield more/longer words than a rack, so a steeper ramp
    seconds: Math.max(50, 75 - (level - 1) * 2),
  };
}

export { starsFor as gridStarsFor };

export type GridPlay = { level: number; score: number; words: number; stars: number; at: number };

export type GridProgress = {
  unlocked: number;
  stars: Record<number, number>;
  best: Record<number, number>;
  history: GridPlay[];
};

const KEY = "wb_grid_progress_v1";
const EMPTY: GridProgress = { unlocked: 1, stars: {}, best: {}, history: [] };

export function loadGridProgress(): GridProgress {
  if (typeof window === "undefined") return { ...EMPTY };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    /* corrupt/absent → fresh */
  }
  return { ...EMPTY };
}

export function saveGridResult(
  p: GridProgress,
  level: number,
  score: number,
  words: number,
  stars: number,
): GridProgress {
  const next: GridProgress = {
    unlocked: Math.max(p.unlocked, stars > 0 ? level + 1 : p.unlocked),
    stars: { ...p.stars, [level]: Math.max(p.stars[level] || 0, stars) },
    best: { ...p.best, [level]: Math.max(p.best[level] || 0, score) },
    history: [{ level, score, words, stars, at: Date.now() }, ...p.history].slice(0, 50),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked → progress just won't persist */
  }
  return next;
}

export function totalGridStars(p: GridProgress): number {
  return Object.values(p.stars).reduce((a, b) => a + b, 0);
}
