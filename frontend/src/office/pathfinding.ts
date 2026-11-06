// A* over the walkability grid. 8-way movement without cutting corners past blocked tiles.

export interface Tile {
  x: number;
  y: number;
}

export function findPath(grid: boolean[][], from: Tile, to: Tile, extraBlocked?: Set<string>): Tile[] | null {
  const H = grid.length;
  const W = grid[0].length;
  const ok = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && grid[y][x] && !(extraBlocked && extraBlocked.has(`${x},${y}`));
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  if (sx === to.x && sy === to.y) return [];
  if (!ok(to.x, to.y)) return null;

  const key = (x: number, y: number) => y * W + x;
  const g = new Map<number, number>();
  const came = new Map<number, number>();
  const open: { k: number; f: number }[] = [];
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
  };
  const sk = key(sx, sy);
  g.set(sk, 0);
  open.push({ k: sk, f: h(sx, sy) });
  const closed = new Set<number>();
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);
    const cx = cur.k % W;
    const cy = Math.floor(cur.k / W);
    if (cx === to.x && cy === to.y) {
      const path: Tile[] = [];
      let k: number | undefined = cur.k;
      while (k !== undefined && k !== sk) {
        path.push({ x: k % W, y: Math.floor(k / W) });
        k = came.get(k);
      }
      return path.reverse();
    }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!ok(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = (g.get(cur.k) ?? 0) + (dx !== 0 && dy !== 0 ? 1.414 : 1);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        came.set(nk, cur.k);
        open.push({ k: nk, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}
