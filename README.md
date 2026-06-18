# duplo

A zero-dependency Node.js CLI that scans a React + Sass/BEM project for duplicate classname definitions across `.jsx`/`.tsx` and `.scss`/`.sass` files.

## Requirements

- Node.js 14+
- No `npm install` needed

## Usage

```bash
node bem-duplicate-finder.js <path-to-repo> [options]
```

### Examples

```bash
# Scan a project
node bem-duplicate-finder.js /path/to/my-app

# Only report BEM-named classes
node bem-duplicate-finder.js /path/to/my-app --only-bem

# Only show high-severity duplicates (3+ occurrences)
node bem-duplicate-finder.js /path/to/my-app --severity high

# Machine-readable JSON output (useful for CI)
node bem-duplicate-finder.js /path/to/my-app --json

# Scan only React files, skip Sass
node bem-duplicate-finder.js /path/to/my-app --ignore-sass

# Scan only Sass files, skip React
node bem-duplicate-finder.js /path/to/my-app --ignore-jsx
```

## Options

| Flag | Description |
|---|---|
| `--only-bem` | Only report classes that follow BEM naming (`block__element--modifier`) |
| `--severity high` | Only show classes duplicated 3 or more times |
| `--json` | Output results as JSON instead of the formatted report |
| `--ignore-sass` | Skip `.scss`, `.sass`, and `.css` files |
| `--ignore-jsx` | Skip `.jsx`, `.tsx`, `.js`, and `.ts` files |

## What it detects

### In React files (`.jsx`, `.tsx`, `.js`, `.ts`)

| Pattern | Example |
|---|---|
| Static `className` | `className="card card--active"` |
| CSS Modules dot notation | `className={styles.card}` |
| CSS Modules bracket notation | `className={styles['card--active']}` |
| Utility functions | `cx('card', 'card--active')`, `clsx(...)`, `cn(...)`, `classNames(...)` |

### In Sass/CSS files (`.scss`, `.sass`, `.css`)

| Pattern | Example |
|---|---|
| Top-level block | `.card { }` |
| BEM child with `&` | `&__header { }`, `&--active { }` |
| Nested plain class | `.card__header { }` inside a rule |
| Multi-selector | `.card, .card--featured { }` |

## Severity levels

| Level | Condition | Meaning |
|---|---|---|
| `HIGH` | 5+ occurrences | Likely a shared component pattern — consider extracting to a global partial |
| `MED` | 3–4 occurrences | May be intentional reuse or an unintentional collision worth reviewing |
| `LOW` | 2 occurrences | Possible duplicate — check whether both usages are needed |

## Ignored directories and files

The following directories are automatically excluded from scanning:

`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.cache`, `out`, `public`, `stories`

The following file patterns are also skipped regardless of where they live:

| Pattern | Example |
|---|---|
| `*.stories.jsx/tsx/js/ts` | `Button.stories.jsx` |
| `*.story.jsx/tsx/js/ts` | `Button.story.tsx` |

This covers story files both inside a dedicated `stories/` folder and colocated next to their components.

## BEM naming

A classname is considered BEM-conformant if it matches:

```
block
block__element
block--modifier
block__element--modifier
```

Where each segment uses lowercase letters, numbers, and hyphens. Non-BEM classes (utility classes, Tailwind, Bootstrap, etc.) are still reported but labelled `[non-BEM]` and can be filtered out with `--only-bem`.

## JSON output

When run with `--json`, the script outputs a structured object suitable for piping into other tools or CI reporters:

```json
{
  "repoPath": "/path/to/my-app",
  "reactFileCount": 42,
  "sassFileCount": 18,
  "totalClassesFound": 310,
  "duplicates": [
    {
      "className": "card__header",
      "count": 4,
      "isBem": true,
      "bemRole": "element",
      "refs": [
        { "file": "src/components/Card/Card.jsx", "line": 12, "source": "jsx:static" },
        { "file": "src/components/Card/Card.scss", "line": 8, "source": "sass:bem-child" }
      ]
    }
  ]
}
```

## CI integration

Pipe JSON output into `jq` or a custom script to fail a build on high-severity duplicates:

```bash
# Fail if any high-severity duplicates exist (count >= 5)
node bem-duplicate-finder.js ./src --json | \
  jq 'if ([.duplicates[] | select(.count >= 5)] | length) > 0 then error("High-severity duplicates found") else . end'
```
