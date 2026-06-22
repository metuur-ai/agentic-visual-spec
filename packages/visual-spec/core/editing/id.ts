/**
 * id.ts — dependency-free id helpers. Kept separate from marker-core so the
 * comment/spec API routes can mint ids without dragging in the Babel parser.
 */
export function randomHex8(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
