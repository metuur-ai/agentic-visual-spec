/**
 * prism-global.ts — establishes the global `Prism` that Luthor's editor needs.
 *
 * Luthor pulls in `@lexical/code`, whose bundled prismjs language components
 * (`prism-clike`, `prism-javascript`, …) assign to a *global* `Prism` at module
 * eval. Under Vite's dependency pre-bundling that global isn't set in time, which
 * throws `ReferenceError: Prism is not defined` before the app even renders.
 *
 * Import this BEFORE `@lyfie/luthor` (ESM evaluates a module's imports in source
 * order), so the global exists by the time Luthor's chunk evaluates.
 */
import Prism from 'prismjs';

(globalThis as typeof globalThis & { Prism?: typeof Prism }).Prism ??= Prism;
