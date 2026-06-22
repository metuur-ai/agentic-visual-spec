/**
 * fiber.ts — resolve a rendered DOM element back to its source line:column.
 *
 * Primary path: the nearest ancestor carrying data-vs-loc (injected by the
 * loc-tags transform) — HMR-proof, no React internals. Fallback: walk the React
 * Fiber `return` chain reading `_debugSource`, matching the surface entry file.
 */

export type SourceLoc = { line: number; column: number; anchor: HTMLElement };

export type FindOptions = {
  /** Restrict matches to elements whose backing node is an HTMLElement. */
  hostOnly?: boolean;
};

const LOC_ATTR = 'data-vs-loc';

export function findSurfaceSource(
  el: Element | null,
  surfaceId: string,
  opts: FindOptions = {},
): SourceLoc | null {
  if (!el) return null;

  // Primary: data-vs-loc attribute.
  const tagged = el.closest(`[${LOC_ATTR}]`);
  if (tagged instanceof HTMLElement) {
    const parsed = parseLoc(tagged.getAttribute(LOC_ATTR));
    if (parsed) return { ...parsed, anchor: tagged };
  }

  // Fallback: React Fiber _debugSource.
  return fromFiber(el, surfaceId, opts);
}

function parseLoc(value: string | null): { line: number; column: number } | null {
  if (!value) return null;
  const [l, c] = value.split(':');
  const line = Number(l);
  const column = Number(c);
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
  return { line, column };
}

/** Strip Vite HMR query (`?t=`) and normalize Windows separators. */
export function normalizeDebugFileName(name: string): string {
  return name.split('?')[0]!.replace(/\\/g, '/');
}

type FiberNode = {
  return: FiberNode | null;
  stateNode: unknown;
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
  memoizedProps?: { __source?: { fileName?: string; lineNumber?: number; columnNumber?: number } };
};

function getFiber(el: Element): FiberNode | null {
  for (const key in el) {
    if (key.startsWith('__reactFiber$')) return (el as unknown as Record<string, FiberNode>)[key]!;
  }
  return null;
}

function fromFiber(el: Element, surfaceId: string, opts: FindOptions): SourceLoc | null {
  let fiber = getFiber(el);
  const suffix = `/surfaces/${surfaceId}/index.tsx`;
  while (fiber) {
    const src = fiber._debugSource ?? fiber.memoizedProps?.__source;
    const file = src?.fileName ? normalizeDebugFileName(src.fileName) : undefined;
    const isHost = fiber.stateNode instanceof HTMLElement;
    if (file?.endsWith(suffix) && src?.lineNumber != null && (!opts.hostOnly || isHost)) {
      const anchor = isHost ? (fiber.stateNode as HTMLElement) : (el as HTMLElement);
      return { line: src.lineNumber, column: src.columnNumber ?? 0, anchor };
    }
    fiber = fiber.return;
  }
  return null;
}
