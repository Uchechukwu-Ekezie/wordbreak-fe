// Level progression + saved progress. The word-finding loop is unchanged; this is the meta
// layer that makes it feel like Candy Crush: discrete replayable levels, goals, stars, unlocks,
// and history — persisted in localStorage.

export type LevelDef = {
  level: number;
  rackSize: number; // letters (5 → 8 as you climb)
  goal: number; // points needed to clear
  seconds: number; // time limit
};

export function levelDef(level: number): LevelDef {
  return {
    level,
    rackSize: Math.min(2 + level, 8), // L1:3, L2:4, L3:5, L4:6, L5:7, L6+:8
    goal: 2 + (level - 1) * 3, // L1:2, L2:5, L3:8, L4:11… (gentle start, ramps up)
    seconds: Math.max(45, 70 - (level - 1) * 2), // 70s → floor 45s
  };
}

// 1★ = hit the goal, 2★ = 1.5×, 3★ = 2×.
export function starsFor(score: number, goal: number): number {
  if (score >= goal * 2) return 3;
  if (score >= Math.ceil(goal * 1.5)) return 2;
  if (score >= goal) return 1;
  return 0;
}

export type Play = { level: number; score: number; words: number; stars: number; at: number };

export type Progress = {
  unlocked: number; // highest level the player can enter
  stars: Record<number, number>; // best stars per level
  best: Record<number, number>; // best score per level
  history: Play[];
};

const KEY = "wb_progress_v1";
const EMPTY: Progress = { unlocked: 1, stars: {}, best: {}, history: [] };

export function loadProgress(): Progress {
  if (typeof window === "undefined") return { ...EMPTY };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    /* corrupt/absent → fresh */
  }
  return { ...EMPTY };
}

export function saveResult(
  p: Progress,
  level: number,
  score: number,
  words: number,
  stars: number,
): Progress {
  const next: Progress = {
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

export function totalStars(p: Progress): number {
  return Object.values(p.stars).reduce((a, b) => a + b, 0);
}
