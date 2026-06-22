/**
 * default-ignore.ts — patterns hidden from the directory browser by default.
 *
 * These are build outputs, dependencies, caches, secrets, and editor cruft that
 * nobody wants to review. They are applied BEFORE the user's `.visualspecignore`,
 * so a project can un-hide any of them with a negation (e.g. `!dist/`). Contrast
 * with the unconditional always-ignores in tree-store.ts (`.git/`, `node_modules/`,
 * `visual-spec-comments.json`) which can't be overridden.
 */
export const DEFAULT_IGNORE: string[] = [
  // OS / editor cruft
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.vscode/',
  '.idea/',
  '*.iml',
  '*.lock',
  '.classpath',
  '.project',
  '.settings/',

  // Java / JVM
  'target/',
  '*.class',
  '*.jar',
  '*.war',
  '*.ear',
  '.gradle/',
  '.mvn/',

  // Go
  'exe/',
  '*.exe',
  '*.exe~',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.test',
  '*.out',

  // JavaScript / TypeScript
  'jspm_packages/',
  'web_modules/',
  '.npm/',
  'out/',
  'dist/',
  'build/',
  '.next/',
  '.nuxt/',
  '.docusaurus/',
  'tsconfig.tsbuildinfo',

  // Python
  '__pycache__/',
  '*.py[cod]',
  '*$py.class',
  'venv/',
  '.venv/',
  'env/',
  '.env/',
  'develop-eggs/',
  'downloads/',
  'eggs/',
  '.eggs/',
  'lib/',
  'lib64/',
  'parts/',
  'sdist/',
  'var/',
  'wheels/',
  'pip-wheel-metadata/',
  'share/python-wheels/',
  '*.egg-info/',

  // Rust
  '**/*.rs.bk',

  // C# / .NET
  'bin/',
  'obj/',
  '*.suo',
  '*.user',
  '*.userosscache',
  '*.sln.docstates',
  '_ReSharper.*/',

  // Generic deps / vendored
  'vendor/',
  // NOTE: `packages/` was in the source list but is intentionally NOT ignored
  // here — it holds source in monorepos. Add it to .visualspecignore per-project
  // if you really want it hidden.

  // Environment & secrets
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '*.pem',
  '*.key',

  // Caches & temp
  '.cache/',
  '.pytest_cache/',
  '.sass-cache/',

  // Coverage & test reports
  'coverage/',
  '.nyc_output/',
  'htmlcov/',
  '.coverage',
  'nosetests.xml',

  // Logs
  '*.log',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
];
