# Build & install on another computer

The cleanest way to move Visual Specs to another machine is `npm pack` — it
produces a tarball of exactly what gets published (the `dist/` folder, per the
`files` field in `package.json`), which you then install globally. No need to copy
`node_modules` or source.

## 1. Build & package (on this machine)

```bash
cd packages/visual-spec
npm run build          # tsup + vite build + build.mjs → produces dist/
npm pack               # → metuur-visual-spec-<version>.tgz (only dist/ + package.json)
```

`npm pack` respects `"files": ["dist"]`, so the tarball contains just the built
CLI + UI + skills — nothing else. The filename flattens the scope, e.g.
**`metuur-visual-spec-0.1.3.tgz`**.

## 2. Transfer + install (on the other computer)

Copy that one `.tgz` over (AirDrop / USB / `scp`), then:

```bash
npm install -g ./metuur-visual-spec-0.1.3.tgz
visual-spec --version
visual-spec .          # run it on any directory
```

The `visual-spec` command is now on the other machine's PATH (**Node ≥ 18**
required there).

---

## Notes & alternatives

- **Why not just zip the whole folder?** You'd be copying `node_modules` and
  source unnecessarily. If you do want a plain zip, build first and zip only what
  ships:

  ```bash
  npm run build && zip -r visual-spec.zip dist package.json
  ```

  Then on the other side: `npm install -g /path/to/unzipped-folder`. The `.tgz`
  route is simpler and produces an identical result.

- **scp one-liner:**

  ```bash
  scp metuur-visual-spec-0.1.3.tgz user@host:~/
  # then SSH over and run the install command above
  ```

- The tarball is **self-contained**: `@babel/*` and `ignore` are bundled into
  `dist/cli.js` at build time (esbuild), so the global install pulls only the
  runtime deps it still needs.
