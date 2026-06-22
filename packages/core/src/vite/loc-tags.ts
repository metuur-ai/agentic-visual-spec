/**
 * loc-tags.ts — the element-identity linchpin (Phase 2).
 *
 * A dev-only transform that injects `data-vs-loc="<line>:<column>"` onto every
 * host JSX element in a surface, where line:column is the element's source
 * position (Babel `loc.start`). The browser inspector reads this attribute to
 * resolve any clicked DOM node back to its exact source location — which is the
 * coordinate `findInsertion` consumes. data-vs-loc encodes the JSX element start
 * (the `<`), 1-indexed line / 0-indexed column, matching marker-core.
 *
 * Stripped from production: the plugin runs `apply: 'serve'` only.
 */
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { Plugin } from 'vite';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/** Capitalized components known to forward props onto a single host element. */
export const FORWARDING_COMPONENTS = new Set<string>(['ImagePlaceholder']);

const LOC_ATTR = 'data-vs-loc';

function isHostTag(tag: string): boolean {
  return /^[a-z]/.test(tag) || FORWARDING_COMPONENTS.has(tag);
}

/**
 * Pure transform: inject data-vs-loc on host JSX opening tags. Insertions are
 * applied in reverse offset order so earlier positions stay valid; formatting is
 * preserved (string splice, not codegen).
 */
export function injectLocTags(code: string): string {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const inserts: { pos: number; text: string }[] = [];

  traverse(ast, {
    JSXOpeningElement(path) {
      const name = path.node.name;
      if (name.type !== 'JSXIdentifier') return; // skip member/namespaced names
      if (!isHostTag(name.name)) return;
      // skip if already tagged (idempotent across HMR re-transforms)
      const tagged = path.node.attributes.some(
        (a) => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === LOC_ATTR,
      );
      if (tagged) return;

      const element = path.parentPath.node; // JSXElement
      const loc = element.loc?.start;
      if (!loc || name.end == null) return;
      inserts.push({ pos: name.end, text: ` ${LOC_ATTR}="${loc.line}:${loc.column}"` });
    },
  });

  inserts.sort((a, b) => b.pos - a.pos);
  let out = code;
  for (const ins of inserts) out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
  return out;
}

/** Match `…/surfaces/<id>/*.{tsx,jsx}`, excluding declaration/test files. */
export function isSurfaceModule(id: string, surfacesDir = 'surfaces'): boolean {
  const clean = id.split('?')[0]!.replace(/\\/g, '/');
  if (/\.d\.ts$/.test(clean) || /\.test\.[jt]sx?$/.test(clean)) return false;
  const re = new RegExp(`/${surfacesDir}/[^/]+/.*\\.[jt]sx$`);
  return re.test(clean);
}

// ---------------------------------------------------------------------------
// Vite plugin wrapper
// ---------------------------------------------------------------------------

export function locTagsPlugin(opts: { surfacesDir?: string } = {}): Plugin {
  const surfacesDir = opts.surfacesDir ?? 'surfaces';
  return {
    name: 'visual-spec:loc-tags',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      if (!isSurfaceModule(id, surfacesDir)) return null;
      return { code: injectLocTags(code), map: null };
    },
  };
}
