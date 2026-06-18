#!/usr/bin/env node

/**
 * duplo - BEM Duplicate Classname Finder
 * Scans a React + Sass/BEM project for duplicate classname definitions
 *
 * Usage:
 *   node bem-duplicate-finder.js <path-to-repo>
 *   node bem-duplicate-finder.js <path-to-repo> --json
 *   node bem-duplicate-finder.js <path-to-repo> --only-bem
 *   node bem-duplicate-finder.js <path-to-repo> --severity high
 */

const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────

const REACT_EXTENSIONS = [".jsx", ".tsx", ".js", ".ts"];
const SASS_EXTENSIONS = [".scss", ".sass", ".css"];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "out",
  "public",
  "stories",
]);

// Files matching these patterns are always skipped
const IGNORE_FILE_PATTERNS = [
  /\.stories\.[jt]sx?$/,  // Button.stories.jsx / Button.stories.tsx
  /\.story\.[jt]sx?$/,    // Button.story.jsx
];

// BEM pattern: block__element--modifier
const BEM_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$/;

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

const paint = (color, text) => `${color}${text}${c.reset}`;

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error(paint(c.red, "Error: Please provide a path to a repository."));
    console.log(`\n  Usage: node bem-duplicate-finder.js ${paint(c.cyan, "<path-to-repo>")} [options]\n`);
    console.log("  Options:");
    console.log("    --json          Output results as JSON");
    console.log("    --only-bem      Only report BEM-named classes");
    console.log("    --severity high Only show classes duplicated 3+ times");
    console.log("    --ignore-sass   Skip Sass/CSS file scanning");
    console.log("    --ignore-jsx    Skip React file scanning\n");
    process.exit(1);
  }

  return {
    repoPath: path.resolve(args[0]),
    outputJson: args.includes("--json"),
    onlyBem: args.includes("--only-bem"),
    highSeverity: args.includes("--severity") && args[args.indexOf("--severity") + 1] === "high",
    ignoreSass: args.includes("--ignore-sass"),
    ignoreJsx: args.includes("--ignore-jsx"),
  };
}

// ─── File walking ─────────────────────────────────────────────────────────────

function* walkDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full);
    } else if (entry.isFile()) {
      if (!IGNORE_FILE_PATTERNS.some((re) => re.test(entry.name))) {
        yield full;
      }
    }
  }
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

/**
 * Extract classnames from JSX/TSX/JS files.
 * Handles: className="foo bar", className={styles.foo}, cx('foo', 'bar'),
 *           clsx(...), cn(...), classNames(...), template literals.
 */
function extractFromReact(content, filePath) {
  const found = []; // { className, line }

  const lines = content.split("\n");

  lines.forEach((line, i) => {
    const lineNum = i + 1;

    // className="foo bar baz"  or  className='foo bar'
    const staticMatches = line.matchAll(/className\s*=\s*["'`]([^"'`]+)["'`]/g);
    for (const m of staticMatches) {
      m[1].trim().split(/\s+/).forEach((cls) => {
        if (cls) found.push({ className: cls, line: lineNum, source: "jsx:static" });
      });
    }

    // className={styles.foo}  or  className={styles['foo-bar']}
    const cssModuleMatches = line.matchAll(/className\s*=\s*\{styles\.([a-zA-Z0-9_-]+)\}/g);
    for (const m of cssModuleMatches) {
      found.push({ className: m[1], line: lineNum, source: "jsx:cssmodule" });
    }
    const cssModuleBracket = line.matchAll(/className\s*=\s*\{styles\[['"]([^'"]+)['"]\]\}/g);
    for (const m of cssModuleBracket) {
      found.push({ className: m[1], line: lineNum, source: "jsx:cssmodule" });
    }

    // cx('foo', 'bar'), clsx(...), cn(...), classNames(...)
    const utilMatches = line.matchAll(/(?:cx|clsx|cn|classNames)\s*\(([^)]+)\)/g);
    for (const m of utilMatches) {
      const inner = m[1];
      const strMatches = inner.matchAll(/["'`]([a-zA-Z0-9_\- ]+)["'`]/g);
      for (const s of strMatches) {
        s[1].trim().split(/\s+/).forEach((cls) => {
          if (cls) found.push({ className: cls, line: lineNum, source: "jsx:util" });
        });
      }
    }
  });

  return found;
}

/**
 * Extract class selectors from Sass/CSS files.
 * Handles: .block, .block__element, .block--modifier, nested BEM with &
 */
function extractFromSass(content, filePath) {
  const found = [];
  const lines = content.split("\n");

  // Track nesting to resolve & references
  const blockStack = [];

  lines.forEach((line, i) => {
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Closing brace — pop stack
    if (trimmed === "}") {
      blockStack.pop();
      return;
    }

    // Class selector lines: .foo, .foo .bar, &__element, &--modifier
    const selectorLine = trimmed.replace(/\{.*$/, "").trim();

    // Top-level class: .block {
    const topClass = selectorLine.match(/^\.([a-zA-Z][a-zA-Z0-9_-]*)$/);
    if (topClass) {
      blockStack.push(topClass[1]);
      found.push({ className: topClass[1], line: lineNum, source: "sass:block" });
      return;
    }

    // BEM child with &: &__element or &--modifier
    const bemRef = selectorLine.match(/^&(__[a-zA-Z0-9_-]+|--[a-zA-Z0-9_-]+)/);
    if (bemRef && blockStack.length) {
      const parent = blockStack[blockStack.length - 1];
      const full = parent + bemRef[1];
      blockStack.push(full);
      found.push({ className: full, line: lineNum, source: "sass:bem-child" });
      return;
    }

    // Plain class inside a rule: .block__element {
    const nestedClass = selectorLine.match(/^\.([a-zA-Z][a-zA-Z0-9_-]*)$/);
    if (nestedClass) {
      found.push({ className: nestedClass[1], line: lineNum, source: "sass:nested" });
      return;
    }

    // Multiple selectors on one line: .foo, .bar {
    if (selectorLine.includes(",")) {
      selectorLine.split(",").forEach((part) => {
        const m = part.trim().match(/^\.([a-zA-Z][a-zA-Z0-9_-]*)$/);
        if (m) found.push({ className: m[1], line: lineNum, source: "sass:multi" });
      });
    }
  });

  return found;
}

// ─── BEM checker ─────────────────────────────────────────────────────────────

function isBem(className) {
  return BEM_PATTERN.test(className);
}

function bemRole(className) {
  if (className.includes("--")) return "modifier";
  if (className.includes("__")) return "element";
  return "block";
}

// ─── Main scanner ─────────────────────────────────────────────────────────────

function scan(repoPath, opts) {
  if (!fs.existsSync(repoPath)) {
    console.error(paint(c.red, `Error: Path not found: ${repoPath}`));
    process.exit(1);
  }

  // classname → [{ file, line, source }]
  const registry = new Map();

  let reactFileCount = 0;
  let sassFileCount = 0;

  for (const filePath of walkDir(repoPath)) {
    const ext = path.extname(filePath).toLowerCase();
    const rel = path.relative(repoPath, filePath);

    if (!opts.ignoreJsx && REACT_EXTENSIONS.includes(ext)) {
      const content = fs.readFileSync(filePath, "utf8");
      const hits = extractFromReact(content, filePath);
      reactFileCount++;
      for (const { className, line, source } of hits) {
        if (!registry.has(className)) registry.set(className, []);
        registry.get(className).push({ file: rel, line, source });
      }
    }

    if (!opts.ignoreSass && SASS_EXTENSIONS.includes(ext)) {
      const content = fs.readFileSync(filePath, "utf8");
      const hits = extractFromSass(content, filePath);
      sassFileCount++;
      for (const { className, line, source } of hits) {
        if (!registry.has(className)) registry.set(className, []);
        registry.get(className).push({ file: rel, line, source });
      }
    }
  }

  // Filter to duplicates only
  let duplicates = [...registry.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([className, refs]) => ({
      className,
      count: refs.length,
      isBem: isBem(className),
      bemRole: isBem(className) ? bemRole(className) : null,
      refs,
    }))
    .sort((a, b) => b.count - a.count);

  if (opts.onlyBem) {
    duplicates = duplicates.filter((d) => d.isBem);
  }

  if (opts.highSeverity) {
    duplicates = duplicates.filter((d) => d.count >= 3);
  }

  return {
    repoPath,
    reactFileCount,
    sassFileCount,
    totalClassesFound: registry.size,
    duplicates,
  };
}

// ─── Reporters ────────────────────────────────────────────────────────────────

function severityLabel(count) {
  if (count >= 5) return paint(c.red + c.bold, "● HIGH  ");
  if (count >= 3) return paint(c.yellow, "● MED   ");
  return paint(c.dim, "● LOW   ");
}

function printReport(result, opts) {
  const { repoPath, reactFileCount, sassFileCount, totalClassesFound, duplicates } = result;
  const total = reactFileCount + sassFileCount;

  console.log("\n" + paint(c.bold, "━".repeat(70)));
  console.log(paint(c.bold + c.cyan, "  BEM Duplicate Classname Finder"));
  console.log(paint(c.bold, "━".repeat(70)));
  console.log(paint(c.dim, `  Repo   : ${repoPath}`));
  console.log(paint(c.dim, `  Scanned: ${total} files  (${reactFileCount} React, ${sassFileCount} Sass/CSS)`));
  console.log(paint(c.dim, `  Unique classnames found: ${totalClassesFound}`));
  if (opts.onlyBem) console.log(paint(c.dim, "  Filter : BEM only"));
  if (opts.highSeverity) console.log(paint(c.dim, "  Filter : High severity (3+ occurrences)"));
  console.log(paint(c.bold, "━".repeat(70)) + "\n");

  if (!duplicates.length) {
    console.log(paint(c.green + c.bold, "  ✓ No duplicate classnames found!\n"));
    return;
  }

  // Summary by BEM role
  const blocks = duplicates.filter((d) => d.bemRole === "block").length;
  const elements = duplicates.filter((d) => d.bemRole === "element").length;
  const modifiers = duplicates.filter((d) => d.bemRole === "modifier").length;
  const nonBem = duplicates.filter((d) => !d.isBem).length;

  console.log(paint(c.bold, `  Found ${paint(c.red, String(duplicates.length))} duplicate classname(s)\n`));

  if (blocks + elements + modifiers + nonBem > 0) {
    const row = [
      blocks ? paint(c.cyan, `${blocks} block`) : null,
      elements ? paint(c.magenta, `${elements} element`) : null,
      modifiers ? paint(c.yellow, `${modifiers} modifier`) : null,
      nonBem ? paint(c.dim, `${nonBem} non-BEM`) : null,
    ]
      .filter(Boolean)
      .join("  ");
    console.log("  " + row + "\n");
  }

  console.log(paint(c.bold, "━".repeat(70)));

  for (const dup of duplicates) {
    const bemTag = dup.isBem
      ? paint(c.dim, `[${dup.bemRole}]`)
      : paint(c.dim, "[non-BEM]");
    const countBadge = paint(c.bold, `×${dup.count}`);

    console.log(
      `\n  ${severityLabel(dup.count)} ${paint(c.bold + c.white, dup.className)}  ${countBadge}  ${bemTag}`
    );

    // Group refs by file for tidier output
    const byFile = new Map();
    for (const ref of dup.refs) {
      if (!byFile.has(ref.file)) byFile.set(ref.file, []);
      byFile.get(ref.file).push(ref);
    }

    for (const [file, refs] of byFile) {
      const lines = refs.map((r) => `L${r.line}`).join(", ");
      const srcTypes = [...new Set(refs.map((r) => r.source))].join(", ");
      const fileShort = file.length > 55 ? "…" + file.slice(-54) : file;
      console.log(
        `       ${paint(c.cyan, fileShort)}  ${paint(c.dim, lines)}  ${paint(c.dim, srcTypes)}`
      );
    }
  }

  console.log("\n" + paint(c.bold, "━".repeat(70)));

  // Recommendations
  console.log(paint(c.bold, "\n  Recommendations\n"));
  const highCount = duplicates.filter((d) => d.count >= 5).length;
  const medCount = duplicates.filter((d) => d.count >= 3 && d.count < 5).length;

  if (highCount) {
    console.log(
      `  ${paint(c.red, "●")} ${highCount} high-severity duplicate(s) — likely shared BEM blocks that\n` +
      `    should be extracted into a global _components.scss partial.`
    );
  }
  if (medCount) {
    console.log(
      `  ${paint(c.yellow, "●")} ${medCount} medium-severity duplicate(s) — consider whether these are\n` +
      `    intentional cross-component reuses or unintentional collisions.`
    );
  }
  if (nonBem) {
    console.log(
      `  ${paint(c.dim, "●")} ${nonBem} non-BEM classname(s) duplicated — these may be utility classes\n` +
      `    (e.g. Tailwind, Bootstrap) which are fine to ignore, or could indicate\n` +
      `    naming inconsistencies worth aligning to BEM.`
    );
  }

  console.log();
}

function printJson(result) {
  console.log(JSON.stringify(result, null, 2));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const opts = parseArgs();
const result = scan(opts.repoPath, opts);

if (opts.outputJson) {
  printJson(result);
} else {
  printReport(result, opts);
}
