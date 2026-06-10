# Front Intelligence Extension Design

## Overview

This project will evolve from `alias-file-finder` into a performance-first frontend intelligence extension for VS Code. Its purpose is to supplement gaps in existing editor support for Vue and CSS-preprocessor projects, especially where project-level aliases, global Vue components, component documentation, and static cross-file relationships are not recognized reliably.

The extension is not intended to replace Volar, Stylelint, Sass language support, or other language plugins. It should complement them by providing fast, conservative static analysis for project-specific patterns.

## Product Scope

The extension will cover these domains:

- CSS-family alias navigation for `css`, `scss`, `sass`, `less`, `stylus`, `postcss`, and style blocks inside `vue`, `svelte`, `astro`, and `html`.
- Sass and SCSS intelligence for mixin definitions, `@include` usage, function definitions, function calls, and later selector assistance for `&` and BEM-style naming.
- Vue component recognition for globally available or auto-imported components that VS Code cannot resolve by default.
- Vue component documentation support from component-level JSDoc, prop comments, prop metadata, emit comments, and emit signatures.
- Vue provide/inject navigation for statically analyzable keys.
- A complete settings model that allows each feature to be enabled, disabled, tuned, and debugged.

The original alias feature remains a core capability. It becomes the shared foundation used by CSS navigation, Sass symbol resolution, and Vue global component lookup.

## Performance Requirements

Performance is the primary design constraint.

The extension must remain smooth on low-performance machines and should use additional capacity on high-performance machines to complete indexing faster.

Required behavior:

- Extension activation must not perform a full workspace scan.
- Features must initialize lazily when a user triggers definition, hover, completion, references, or an explicit indexing command.
- Providers must not block the UI while waiting for full-project indexing.
- File changes must trigger single-file incremental updates, not full index rebuilds.
- Background indexing must be batched and scheduled so user-triggered operations have priority.
- Expensive parsing must happen only when needed and must be cached by file path and mtime.
- Users must be able to choose a performance profile.

Performance profiles:

- `lowPower`: minimum background work, low concurrency, current-file-first parsing, no aggressive prewarming.
- `balanced`: default mode, lazy indexing with idle background batches.
- `highPerformance`: higher concurrency, more aggressive background prewarming, faster full-project index completion.

## Architecture

Use a shared indexing core rather than independent providers that scan and parse files on their own.

The high-level flow is:

```text
VS Code Provider
  -> Feature Module
    -> SettingsService
    -> ProjectContext
    -> Resolver or Index Query
      -> Cache Layer
      -> PerformanceScheduler
      -> Parser Worker
```

### Core Services

`SettingsService`

- Reads the new configuration namespace.
- Keeps compatibility with the existing `aliasFileFinder.aliases` setting.
- Normalizes feature flags, performance profiles, include rules, exclude rules, alias settings, and debug settings.

`ProjectContext`

- Represents each workspace folder.
- Owns project-level paths, include/exclude rules, config-file state, and per-workspace caches.
- Supports multi-root workspaces.

`AliasResolver`

- Automatically reads project alias definitions from known configuration files.
- Merges auto-detected aliases with user-defined aliases.
- Provides deterministic priority and fallback behavior.

`FileResolver`

- Resolves import specs through aliases, relative paths, workspace-root paths, `src` fallback paths, extensions, partial files, and index files.
- Converts resolved filesystem paths to VS Code URIs consistently.

`IndexManager`

- Owns file indexes, symbol indexes, and metadata caches.
- Handles initial lazy indexing, incremental single-file updates, deletes, and invalidation.

`PerformanceScheduler`

- Controls concurrency, batch size, background indexing, and priority between user-triggered queries and background work.
- Adapts defaults based on the selected performance profile.

`Diagnostics`

- Provides commands for index status, clearing caches, rebuilding indexes, and debug logging.
- Never interrupts normal editing for non-fatal parse failures.

## Alias Design

Alias configuration is a first-class feature.

The extension should work without manual alias configuration by reading project config files. It must also allow users to define aliases explicitly.

Recommended configuration model:

```json
{
  "frontIntelligence.alias.enabled": true,
  "frontIntelligence.alias.autoDetect": true,
  "frontIntelligence.alias.sources": [
    "tsconfig.json",
    "jsconfig.json",
    "vite.config.*",
    "webpack.config.*",
    "vue.config.*",
    "nuxt.config.*",
    "config.*"
  ],
  "frontIntelligence.alias.custom": {
    "@": "src",
    "~": "src",
    "@components": "src/components",
    "@styles": ["src/styles", "src/assets/styles"]
  },
  "frontIntelligence.alias.priority": "custom-first",
  "frontIntelligence.alias.fallbacks": {
    "@": "src",
    "~": "src"
  }
}
```

Rules:

- `autoDetect` defaults to `true`.
- `custom` is authoritative user configuration and must be stable.
- `priority` defaults to `custom-first`.
- If auto-detected and custom aliases share the same key, the custom paths come first and auto-detected paths may supplement them.
- `fallbacks` are used only when the target directories exist and no higher-priority source defines the alias.
- Existing `aliasFileFinder.aliases` is read for compatibility and treated as custom aliases, with the new namespace preferred.

## Settings Model

Recommended top-level settings:

```json
{
  "frontIntelligence.enabled": true,
  "frontIntelligence.performance.mode": "balanced",
  "frontIntelligence.performance.maxWorkers": 0,
  "frontIntelligence.performance.backgroundIndexing": "auto",
  "frontIntelligence.files.include": [
    "**/*.{vue,css,scss,sass,less,styl,stylus,postcss}"
  ],
  "frontIntelligence.files.exclude": [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/.git/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.output/**",
    "**/coverage/**"
  ],
  "frontIntelligence.css.aliasNavigation.enabled": true,
  "frontIntelligence.scss.symbolNavigation.enabled": true,
  "frontIntelligence.scss.bemSelector.enabled": false,
  "frontIntelligence.vue.componentNavigation.enabled": true,
  "frontIntelligence.vue.componentDocs.enabled": true,
  "frontIntelligence.vue.globalComponents.enabled": true,
  "frontIntelligence.vue.globalComponents.paths": [
    "src/components/**/*.vue",
    "src/**/components/**/*.vue"
  ],
  "frontIntelligence.vue.provideInject.enabled": true,
  "frontIntelligence.debug.logging": false,
  "frontIntelligence.debug.showIndexStatus": true
}
```

All feature modules must respect their own enable flag and the global `frontIntelligence.enabled` flag.

## Indexing Strategy

Use three levels of indexing.

### Lightweight File Index

Stores:

- URI and filesystem path.
- Workspace folder.
- Extension and file type.
- Basename and normalized component-name candidates.
- Last known mtime.

This index is cheap and can be gradually built in the background.

### Symbol Index

Stores:

- Sass mixin and function symbols.
- Vue component file-name candidates.
- Vue provide/inject key sites.
- Vue props and emits summaries where cheap.

This index is built lazily and incrementally.

### Deep Metadata Cache

Stores:

- Full component-level JSDoc.
- Prop comments, prop types, defaults, required flags.
- Emit comments and signatures.
- More expensive Sass metadata.

This cache is populated only when hover, completion, or detailed documentation requires it.

## Query Strategy

Queries must be fast and conservative.

- Current file and already indexed data are checked first.
- If a direct result is available, return it immediately.
- If full indexing is not complete, do not block the provider.
- Background indexing can improve later queries.
- Multiple valid matches should be returned as multiple `LocationLink` results.
- Dynamic expressions that cannot be resolved statically should not be guessed.

## Feature Modules

### CSS Alias Module

Responsibilities:

- Resolve `@import`, `@use`, `@forward`, `@require`, and compatible CSS-family import statements.
- Support CSS-family files and style blocks in Vue, Svelte, Astro, and HTML.
- Use `AliasResolver` and `FileResolver`.
- Support extension candidates, Sass partials, and index files.
- Ignore built-in Sass modules such as `sass:map`.

### Sass Intelligence Module

Responsibilities:

- Resolve `@include` to `@mixin` definitions.
- Resolve function calls to `@function` definitions.
- Index Sass symbols incrementally.
- Later support selector assistance for `&` expansion and BEM-style patterns.

Initial BEM support should default to disabled because selector expansion can create false positives.

### Vue Component Module

Responsibilities:

- Resolve component tags to local or global `.vue` component files.
- Support PascalCase and kebab-case matching.
- Use configured global component paths.
- Return multiple candidates for ambiguous names.
- Later support framework or plugin conventions such as Nuxt and generated auto-import declarations.

### Vue Docs Module

Responsibilities:

- Parse component-level JSDoc.
- Parse `defineProps`, `withDefaults`, destructured defaults, Options API props, and runtime props.
- Parse `defineEmits` and Options API emits.
- Provide hover and completion metadata without forcing full-project scans.

### Vue Provide/Inject Module

Responsibilities:

- Resolve static string keys in `provide('key')` and `inject('key')`.
- Support Options API `provide` and `inject`.
- Provide inject-to-provide definition and provide-to-inject references.
- Defer Symbol and `InjectionKey` cross-file analysis to a later phase.

## Error Handling

The extension should fail quietly and degrade gracefully.

- If one alias source cannot be parsed, skip it and keep other alias sources.
- If one file cannot be parsed, skip that file and keep the rest of the index.
- If a query depends on unfinished indexing, return available results only.
- If an expression is dynamic or ambiguous beyond safe static analysis, do not invent a result.
- Debug logs should explain failures only when debug logging is enabled.

## Commands

Recommended commands:

- `frontIntelligence.clearCache`
- `frontIntelligence.reindexWorkspace`
- `frontIntelligence.reindexCurrentFile`
- `frontIntelligence.showIndexStatus`
- `frontIntelligence.showResolvedAliases`

Existing command compatibility:

- Keep `alias-file-finder.clearCache` as a compatibility command or alias during migration.

## Development Phases

### Phase 0: Product Positioning and Configuration

- Rename and reposition the project in README and package metadata.
- Introduce the new `frontIntelligence` configuration namespace.
- Keep compatibility with `aliasFileFinder.aliases`.
- Define performance profiles, include/exclude rules, feature flags, and debug commands.

### Phase 1: Performance Core Refactor

- Extract `SettingsService`, `AliasResolver`, and `FileResolver`.
- Add shared project context and cache invalidation.
- Add initial `PerformanceScheduler`.
- Preserve current CSS alias behavior.
- Ensure activation does not full-scan the workspace.

### Phase 2: Vue Capability Refactor

- Move Vue component index into the shared indexing model.
- Move component docs parsing into a deep metadata cache.
- Move provide/inject into the shared symbol index.
- Keep hover, completion, definition, and references responsive under partial indexing.

### Phase 3: Sass Semantic Intelligence

- Add Sass mixin/function symbol scanning.
- Add definition providers for `@include` and function calls.
- Add cautious selector assistance for `&` and BEM scenarios.
- Keep BEM support disabled by default until false-positive behavior is understood.

### Phase 4: Productization

- Complete README, configuration reference, migration notes, and examples.
- Add index status and alias inspection commands.
- Expand automated test coverage.
- Package and validate release artifacts.

## Testing Strategy

Use three categories of tests.

Pure function tests:

- Alias merging and priority.
- Alias source parsing.
- Path resolution with aliases, partials, extensions, and index files.
- Vue props, emits, JSDoc, and provide/inject scanning.
- Sass symbol scanning.

Provider tests:

- CSS document links and definitions.
- Vue component definitions.
- Vue hover and completion.
- Vue provide/inject references.
- Future Sass definition providers.

Performance behavior tests:

- Activation does not scan the workspace.
- Feature indexes are lazy.
- File save updates only the current file.
- Config changes invalidate only affected caches.
- Exclude rules are respected.
- Background indexing does not block provider responses.

## Acceptance Criteria

The design is successful when:

- Users can rely on automatic alias detection without manual setup.
- Users can override or add aliases explicitly.
- Low-performance machines remain responsive with `lowPower` or default settings.
- High-performance machines can use aggressive background indexing to accelerate lookup completeness.
- Existing CSS alias navigation remains reliable.
- Vue and Sass features can be enabled or disabled independently.
- The architecture supports adding Sass mixin/function and BEM support without provider-level scanning duplication.
