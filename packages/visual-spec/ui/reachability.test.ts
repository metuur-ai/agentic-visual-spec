/**
 * reachability.test.ts — task U-1's standing guard.
 *
 * WHY THIS EXISTS. Four finished, fully-tested collaboration modules — `collab-editor`,
 * `collab-comment-source`, `cache-lifecycle` and `createRecoveryBodies` — sat in the tree
 * for weeks with a green suite and zero non-test callers. Nothing imported them from the
 * running app, so nothing they did reached a user. The suite could not see it: a module
 * with its own passing tests looks exactly like a module that ships.
 *
 * "Is it tested" and "is it reachable" are different questions, and only the first one was
 * being asked. This asks the second: every browser-side collaboration module must be
 * reachable, through the static import graph, from the app's real entry point.
 *
 * WHAT IT WILL AND WILL NOT CATCH. It is a *wiring* check, not a behaviour check. A module
 * that is imported and then never rendered still passes here — reachability is the floor,
 * not the ceiling. What it does catch is the specific, silent, repeated failure above:
 * building the thing and forgetting to plug it in.
 *
 * The list is derived from disk, not hand-written, so a `ui/collab-*.tsx` module added by
 * a later task is covered the moment it lands rather than when someone remembers to add
 * it here. That is the property that would have caught all four originals.
 *
 * WHY THERE IS A SECOND, FINER GUARD BELOW (O-10). Module granularity has a floor it
 * cannot see under. `ui/collab-client.ts` exported `start` — the only way to create a
 * document — and nothing called it, for weeks, with this file green: the *module* is
 * imported (for `document`, `comments`, `publish`), so a dead exported operation sat
 * inside a live module and looked exactly like a live one. "Is the file wired in" and
 * "is this operation wired in" are, again, different questions.
 *
 * The second `describe` asks the finer one, for the collaboration client's typed surface:
 * every member of the `CollabClient` interface must be referenced from some non-test
 * module the app statically reaches. It resolves symbols through TypeScript's own checker
 * rather than grepping for names, because `.start(` matches `hub.start(` and
 * `applyHub.start(` all over `core/` — a name match would have declared O-10 healthy.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { walkImportGraph } from '../core/import-graph';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one route into the browser app. If this is wrong, every assertion below is vacuous. */
const APP_ENTRY = 'ui/App.tsx';

/**
 * Modules that must be reachable from `APP_ENTRY`. Prefix-matched against `ui/` rather
 * than listed, for the reason in the header. `.ts` and `.tsx` both count: the collaboration
 * UI is a mix of components and the plain-module helpers they are built from, and an
 * orphaned helper is as dead as an orphaned component.
 */
const COLLAB_UI = /^collab-[\w-]+\.tsx?$/;

/** Test files are not the app; a module reachable only from its own test is the bug. */
const IS_TEST = /\.test\.tsx?$/;

/**
 * Modules that are unreachable **on purpose**, each with the decision that made them so.
 *
 * This list is the point of the guard, not a hole in it. An orphan is only a defect when
 * nobody chose it; the failure this test exists to prevent is the *silent* one. Adding an
 * entry here costs a line of justification and shows up in review — which is exactly the
 * conversation that never happened for the four originals.
 *
 * Every entry must name the decision, not merely restate the fact.
 */
const DELIBERATELY_UNMOUNTED: Record<string, string> = {
  'ui/collab-document-view.tsx':
    'Retired with the JSON document format (R-0.1/R-0.2). It walked a canonical `doc.root` and stamped ' +
    '`data-vs-node-id` on every block; the review surface now renders the Markdown through `MarkdownSurface` ' +
    'and anchors on `data-vs-loc` (R-7.3), so there is no tree to walk and no id to stamp. Left on disk ' +
    'pending deletion, unmounted so nothing can grow a second renderer against it.',
  'ui/collab-anchor-resolver.ts':
    'Retired with `nodeId` identity (Unit 2). It located a block by `[data-vs-node-id]`, which no rendered ' +
    'document carries any more; R-6.6 now requires collaboration and local mode to share one resolver, and ' +
    'that resolver is `resolveMarkdownAnchors`. Left on disk pending deletion, unmounted so a second anchor ' +
    'path cannot come back through it.',
};

function collabUiModules(): string[] {
  return readdirSync(resolve(pkgRoot, 'ui'))
    .filter((entry) => COLLAB_UI.test(entry) && !IS_TEST.test(entry))
    .map((entry) => `ui/${entry}`)
    .sort();
}

/** Every module the app entry statically reaches, package-relative. */
function reachableFromApp(): Set<string> {
  const reached = new Set<string>();
  walkImportGraph(pkgRoot, APP_ENTRY, ({ file }) => reached.add(relative(pkgRoot, file)));
  return reached;
}

describe('the collaboration UI is reachable from the app (task U-1)', () => {
  const modules = collabUiModules();

  it('finds the collaboration UI modules on disk (guards against a vacuous pass)', () => {
    // If a rename empties this list, every test below would pass by having nothing to check.
    expect(modules.length).toBeGreaterThanOrEqual(7);
    expect(modules).toContain('ui/collab-editor.tsx');
    expect(modules).toContain('ui/collab-comment-source.ts');
  });

  const expected = modules.filter((module) => !(module in DELIBERATELY_UNMOUNTED));

  it.each(expected)('%s is imported, directly or transitively, from ui/App.tsx', (module) => {
    expect([...reachableFromApp()].sort()).toContain(module);
  });

  // The list is empty today — every collaboration module is mounted. `it.each([])` is an
  // error in vitest, so the exception suite reports itself as skipped rather than vanishing
  // silently; the moment an entry is added it runs.
  const unmounted = Object.keys(DELIBERATELY_UNMOUNTED);
  const eachUnmounted = unmounted.length
    ? it.each(unmounted)
    : it.skip.each(['(no recorded exceptions)']);

  eachUnmounted(
    '%s is unreachable, and that is a recorded decision — not an oversight',
    (module) => {
      // Asserted in both directions. If someone wires it up, this fails and the entry
      // above must be deleted; the exception cannot outlive the reason for it.
      expect(modules).toContain(module);
      expect(reachableFromApp().has(module)).toBe(false);
      expect(DELIBERATELY_UNMOUNTED[module].length).toBeGreaterThan(80);
    },
  );

  it('reports absence rather than always passing', () => {
    const reached = reachableFromApp();
    // The negative control needs a module that exists on disk and is never imported by
    // the app. A test file is that by construction, so this control cannot rot the way
    // naming a production module does the moment someone mounts it.
    expect(existsSync(resolve(pkgRoot, 'ui/collab-editor.test.tsx'))).toBe(true);
    expect(reached.has('ui/collab-editor.test.tsx')).toBe(false);
    expect(reached.has('ui/collab-app.tsx')).toBe(true);
    expect(reached.size).toBeGreaterThan(modules.length);
  });
});

/* ------------------------------------------------------------------------------------ *
 * Symbol granularity — the guard O-10 needed.
 * ------------------------------------------------------------------------------------ */

/** The module that declares the client, and the interface that is its whole public surface. */
/*
 * Reachability's known floor, hit again. `collabIndicatorTargets` builds the markers that
 * pin a comment to its block (R-6.2); it is exported from `collab-comment-source.ts`,
 * which the app *does* import — for the panel source — so the module check above was
 * green while the function had no caller anywhere. The result was visible only in a
 * screenshot: four comments listed in the sidebar and not one marker on a block.
 *
 * A name search is enough here, unlike the interface survey below, because the name is
 * unique in the tree. The guard is the pairing: whatever mounts the comment panel must
 * also mount the indicator layer, or a reviewer sees comments that point nowhere.
 */
const RENDERED_PAIRS: { produces: string; consumedBy: string }[] = [
  { produces: 'collabIndicatorTargets', consumedBy: 'IndicatorLayer' },
];

describe('a produced UI model has something that renders it', () => {
  const reachable = [...reachableFromApp()].filter((module) => !IS_TEST.test(module));

  it.each(RENDERED_PAIRS)('$produces is passed to $consumedBy somewhere the app reaches', ({ produces, consumedBy }) => {
    const callers = reachable.filter((module) => {
      const source = readFileSync(resolve(pkgRoot, module), 'utf8');
      return source.includes(`${produces}(`) && source.includes(`<${consumedBy}`);
    });
    expect(callers).not.toEqual([]);
  });
});

/*
 * `IndicatorLayer` and `CommentPanel` both read the active comment from a context whose
 * default `setActiveId` is an empty function. Mount them without the provider and every
 * click on an inline marker does nothing at all — no focused row, no brightened block, no
 * error. `markdown-editor.tsx` mounted it; `collab-app.tsx` did not, so the whole
 * document→sidebar direction was dead in collaboration while the suite stayed green.
 */
describe('whatever renders inline indicators also provides the active-comment context', () => {
  const reachable = [...reachableFromApp()].filter((module) => !IS_TEST.test(module));

  const hosts = reachable.filter((module) => readFileSync(resolve(pkgRoot, module), 'utf8').includes('<IndicatorLayer'));

  it('finds the modules that mount it (guards against a vacuous pass)', () => {
    expect(hosts.length).toBeGreaterThanOrEqual(2);
  });

  it.each(hosts)('%s mounts ActiveCommentProvider', (module) => {
    expect(readFileSync(resolve(pkgRoot, module), 'utf8')).toContain('<ActiveCommentProvider');
  });
});

/*
 * `buildApplyPrompt(..., { mode: 'collab' })` sat finished and tested with no caller for
 * the whole life of the collaboration feature: nothing in the running app could ask an
 * agent to act on a pull request's comments. Module reachability could not see it — the
 * module is imported for the local surface — so this pins the mode itself.
 */
describe("the collab apply prompt has a caller in the app", () => {
  const reachable = [...reachableFromApp()].filter((module) => !IS_TEST.test(module));

  // Callers, not the definition: `apply-prompt.ts` names the mode in its own option type.
  const callersOf = () =>
    reachable.filter((module) => {
      const source = readFileSync(resolve(pkgRoot, module), 'utf8');
      // Skip the module that defines it — it names the mode in its own option type.
      if (source.includes('export function buildApplyPrompt')) return false;
      return source.includes('buildApplyPrompt(') && source.includes("mode: 'collab'");
    });

  it("something the app reaches builds a prompt with mode 'collab'", () => {
    expect(callersOf()).not.toEqual([]);
  });

  /*
   * And it must hand over the same set the panel lists — the OPEN comments. `status` is
   * the local apply-agent flag (R-5.21), never GitHub's resolution, so the handoff must
   * filter on it and on nothing else. A prompt once claimed six comments where the sidebar
   * showed four, because the two surfaces disagreed about what counted.
   */
  it("it hands over the open comments, on `status` alone (R-5.21)", () => {
    for (const module of callersOf()) {
      const source = readFileSync(resolve(pkgRoot, module), 'utf8');
      expect(source).toContain("c.status === 'open'");
      // R-5.13 — nothing on this path may consult or write GitHub's resolution.
      expect(source).not.toMatch(/isResolved|resolveReviewThread|unresolveReviewThread/);
    }
  });

  /*
   * And it must name the file the AGENT will edit — which is now `documentPath` and only
   * `documentPath`. Under the retired JSON format the local store kept the document at a
   * path of its own (`documents/<id>.json`), so the prompt had to be built from that
   * convention rather than from the path on the branch; with Markdown canonical the two
   * are one path, and `fsCollaborationStore` writes the file at `<contentDir>/<documentPath>`
   * with the agent's cwd at `<contentDir>` (`core/bundle-guard.test.ts` pins that pairing).
   */
  it('it names the document by its own path, which is where the agent will find it', () => {
    for (const module of callersOf()) {
      const source = readFileSync(resolve(pkgRoot, module), 'utf8');
      expect(source).toMatch(/documentPath:\s*\w+\.documentPath/);
      expect(source).not.toContain('localDocumentPath(');
    }
  });
});

const CLIENT_MODULE = 'ui/collab-client.ts';
const CLIENT_INTERFACE = 'CollabClient';

/** What one run of the checker learned about one interface. `uncalled` is the defect set. */
type OperationSurvey = {
  /** Every member the interface declares, in declaration order. */
  operations: string[];
  /** Those referenced from at least one non-test module the entry reaches. */
  called: string[];
  /** The rest. An entry here is an exported operation nothing in the app can trigger. */
  uncalled: string[];
};

/**
 * Follow an instantiated or mapped symbol back to the signature it was derived from.
 *
 * `Pick<CollabClient, 'publish'>` produces a *fresh* property symbol whose declarations do
 * not sit in the interface, so comparing declarations alone would call a genuinely-used
 * operation an orphan. Nothing narrows the client that way today; this is here so the
 * first component that does gets a correct answer rather than a false alarm.
 */
function originalDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
  const { target } = symbol as ts.Symbol & { target?: ts.Symbol };
  if (target && target !== symbol) return originalDeclarations(target);
  return symbol.declarations ?? [];
}

/**
 * The three syntactic shapes that reference a member of an object without calling it by
 * a name the checker cannot see. Anything else (`client['a' + 'b']`, a spread into an
 * untyped bag) is invisible here — and would be invisible to a reader too, which is the
 * reason not to write it rather than a reason to widen this.
 */
function referencedMemberName(node: ts.Node): ts.Node | null {
  if (ts.isPropertyAccessExpression(node)) return node.name;
  if (ts.isBindingElement(node)) {
    const name = node.propertyName ?? node.name;
    return ts.isIdentifier(name) ? name : null;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression;
  }
  return null;
}

/**
 * Walk the import graph from `entry`, type-check exactly what it reaches, and report which
 * members of `interfaceName` are referenced by something in that graph.
 *
 * TWO EXCLUSIONS, BOTH DELIBERATE.
 *
 *   - **The declaring module itself.** `createCollabClient` implements every member of the
 *     interface it returns. Counting that would make every operation trivially "called"
 *     and the guard would assert nothing at all — the exact rot this is here to prevent.
 *   - **Test files.** A member reachable only from its own test is the bug, not the fix.
 *     Belt and braces: no test file is reachable from `ui/App.tsx` today, and the control
 *     at the end of the first suite proves that. If one ever becomes reachable, its calls
 *     must still not vouch for an operation the product never triggers.
 *
 * Parameterised rather than hard-wired to `pkgRoot` so the negative control can run the
 * identical code over a fixture with a known orphan in it. A guard whose failure path has
 * never executed is a guard nobody has checked.
 */
function surveyOperations(input: {
  root: string;
  entry: string;
  declaringModule: string;
  interfaceName: string;
  compilerOptions: ts.CompilerOptions;
}): OperationSurvey {
  const { root, entry, declaringModule, interfaceName, compilerOptions } = input;

  const reached: string[] = [];
  walkImportGraph(root, entry, ({ file }) => reached.push(file));
  const inGraph = new Set(reached);

  const program = ts.createProgram({ rootNames: reached, options: { ...compilerOptions, noEmit: true } });
  const checker = program.getTypeChecker();

  const declaring = program.getSourceFile(resolve(root, declaringModule));
  if (!declaring) throw new Error(`${declaringModule} is not reachable from ${entry}`);

  const declared = declaring.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === interfaceName,
  );
  if (!declared) throw new Error(`${interfaceName} is not declared in ${declaringModule}`);

  // Read off the AST, never a list kept here. An operation added to the interface is
  // guarded the moment it lands — which is the property module granularity already has
  // for files and this needs for members.
  const operations = declared.members.flatMap((member) => (member.name ? [member.name.getText()] : []));

  const called = new Set<string>();
  for (const file of program.getSourceFiles()) {
    if (!inGraph.has(file.fileName)) continue;
    if (file.fileName === declaring.fileName) continue;
    if (IS_TEST.test(file.fileName)) continue;
    const visit = (node: ts.Node): void => {
      const name = referencedMemberName(node);
      if (name) {
        const symbol = checker.getSymbolAtLocation(name);
        // The checker, not the spelling: this is what tells `client.start(…)` apart from
        // the six `hub.start(…)` calls in `core/` that share the identifier and nothing else.
        if (symbol && originalDeclarations(symbol).some((decl) => decl.parent === declared)) {
          called.add(symbol.name);
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }

  return {
    operations,
    called: operations.filter((operation) => called.has(operation)),
    uncalled: operations.filter((operation) => !called.has(operation)),
  };
}

/** The package's real compiler options, so the checker sees the code the build sees. */
function packageCompilerOptions(): ts.CompilerOptions {
  const { config } = ts.readConfigFile(resolve(pkgRoot, 'tsconfig.json'), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config, ts.sys, pkgRoot).options;
}

/**
 * Operations known to have no caller **as of this commit**, each with what was found.
 *
 * READ THE FRAMING CAREFULLY — this is not `DELIBERATELY_UNMOUNTED` above. That list
 * records *decisions*; this one records *open defects*. Every entry here is a live
 * O-10-shaped bug that this guard found on its first run and that fixing is a separate
 * call to make. They are written down so the suite fails on the *next* orphan instead of
 * being permanently red and therefore ignored, and so deleting an entry is the visible,
 * reviewable act of closing one.
 *
 * The whole set has one cause: `collab-open-panel.tsx` never migrated to the client. It
 * still issues `GET /__vs/collab`, `POST /__vs/collab/open` and `POST /__vs/collab/start`
 * through its own inline `doFetch`, with its own copy of the response type — which is
 * precisely the "ad-hoc `res.ok` handling" `collab-client.ts`'s own header says it
 * replaced. The three typed operations that were supposed to absorb those calls are dead.
 */
const UNCALLED_OPERATIONS: Record<string, string> = {
  // Empty, and that is the point. It held `availability`, `open` and `start` — all three
  // dead because `collab-open-panel.tsx` issued those routes with its own inline `fetch`
  // instead of the typed client. The panel now goes through the client, so the entries
  // were deleted rather than carried. Anything added here is an open defect, not a
  // decision — `DELIBERATELY_UNMOUNTED` above is where decisions go.
};

describe('every CollabClient operation is reachable from the app (task U-1, symbol granularity)', () => {
  // One program for the whole suite. Type-checking the app graph costs about a second,
  // and `it.each` needs the member list at collection time regardless.
  const survey = surveyOperations({
    root: pkgRoot,
    entry: APP_ENTRY,
    declaringModule: CLIENT_MODULE,
    interfaceName: CLIENT_INTERFACE,
    compilerOptions: packageCompilerOptions(),
  });

  it('reads the operations off the interface (guards against a vacuous pass)', () => {
    // If the interface is renamed or emptied the survey would find nothing to check and
    // every assertion below would pass by vacuity — the same failure mode the module-level
    // suite guards with its own count check.
    expect(survey.operations.length).toBeGreaterThanOrEqual(10);
    expect(survey.operations).toContain('publish');
    expect(survey.operations).toContain('start');
  });

  const expectedCalled = survey.operations.filter((operation) => !(operation in UNCALLED_OPERATIONS));

  it.each(expectedCalled)(
    'CollabClient.%s is referenced from a non-test module reachable from ui/App.tsx',
    (operation) => {
      expect(survey.called).toContain(operation);
    },
  );

  it.each(Object.keys(UNCALLED_OPERATIONS))(
    'CollabClient.%s has no caller, and that is a recorded finding — not a decision',
    (operation) => {
      // Asserted in both directions, like the module-level exceptions. The moment someone
      // routes the panel through the client this fails, and the entry must be deleted:
      // an "open defect" note cannot outlive the defect.
      expect(survey.operations).toContain(operation);
      expect(survey.uncalled).toContain(operation);
      expect(UNCALLED_OPERATIONS[operation].length).toBeGreaterThan(80);
    },
  );

  it('reports absence rather than always passing', () => {
    // The negative control runs the *same* `surveyOperations` over a two-file package
    // built here, where `orphaned` is declared and implemented but never called from the
    // entry. If the check were hardcoded, name-matched, or counted the factory's own
    // implementation as a call, this would come back empty and fail.
    const root = mkdtempSync(join(tmpdir(), 'collab-operation-control-'));
    writeFileSync(
      join(root, 'client.ts'),
      [
        'export interface FixtureClient {',
        '  used(): string;',
        '  orphaned(): string;',
        '}',
        'export function createFixtureClient(): FixtureClient {',
        // Both members are implemented right here, so this doubles as proof that the
        // declaring module is excluded from the caller scan.
        "  return { used: () => 'used', orphaned: () => 'orphaned' };",
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'entry.ts'),
      [
        "import { createFixtureClient } from './client';",
        'export function run(): string {',
        '  return createFixtureClient().used();',
        '}',
      ].join('\n'),
    );

    const control = surveyOperations({
      root,
      entry: 'entry.ts',
      declaringModule: 'client.ts',
      interfaceName: 'FixtureClient',
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true },
    });

    expect(control.operations).toEqual(['used', 'orphaned']);
    expect(control.called).toEqual(['used']);
    expect(control.uncalled).toEqual(['orphaned']);

    // And the real survey is not simply reporting everything as called, which is the way
    // a broken checker would look identical to a clean codebase.
    expect(survey.called.length).toBeGreaterThan(0);
    expect(survey.called).toContain('publish');
  });
});
