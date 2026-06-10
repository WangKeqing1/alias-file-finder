# Front Intelligence Phase 0/1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first implementation slice of the approved Front Intelligence design: new product/configuration surface, performance profile scaffolding, and a refactored alias settings flow while preserving existing CSS and Vue behavior.

**Architecture:** Add focused core/config modules while keeping existing provider APIs stable. Existing providers continue to call `getAliases`, `resolveReferencePath`, and current Vue indexes; the new settings layer becomes the shared source of truth for feature flags, alias configuration, include/exclude defaults, and performance profiles.

**Tech Stack:** TypeScript, VS Code extension API, esbuild, pnpm, vscode-test, ESLint.

---

## Scope

This plan implements Phase 0 and the first safe part of Phase 1 from `docs/superpowers/specs/2026-06-10-front-intelligence-design.md`.

In scope:

- Introduce `frontIntelligence` configuration keys in `package.json`.
- Keep compatibility with `aliasFileFinder.aliases` and `alias-file-finder.clearCache`.
- Add `SettingsService` for normalized config reads.
- Refactor `AliasResolver` to support new custom aliases, legacy aliases, auto detection, source selection, priority, and fallbacks.
- Add a small `PerformanceScheduler` profile resolver so future indexing can share performance defaults.
- Wire configuration invalidation to both old and new namespaces.
- Add tests for alias priority, alias disable behavior, legacy compatibility, and performance profile defaults.

Out of scope for this plan:

- Sass mixin/function navigation.
- BEM selector expansion.
- Deep Vue component index refactor.
- Worker-thread parsing.
- Full product rename of extension ID.

## File Structure

- Modify `package.json`
  - Update display metadata.
  - Add `frontIntelligence.*` settings.
  - Add compatibility and new commands.
- Create `src/config/settingsService.ts`
  - Own typed config defaults and normalized reads.
  - Preserve legacy alias read support.
- Modify `src/config/aliasResolver.ts`
  - Use `SettingsService`.
  - Implement alias source filtering, custom-first merging, legacy compatibility, and fallbacks.
- Create `src/core/performanceScheduler.ts`
  - Resolve low power, balanced, and high performance defaults.
- Modify `src/extension.ts`
  - Clear caches when either `frontIntelligence` or `aliasFileFinder` settings change.
  - Register new command aliases for cache/status/alias inspection where the implementation is cheap.
- Modify `src/test/extension.test.ts`
  - Add focused tests for config normalization, alias merging, and performance defaults.

## Task 1: Add Settings Service

**Files:**

- Create: `src/config/settingsService.ts`
- Test: `src/test/extension.test.ts`

- [ ] **Step 1: Write failing tests for normalized settings**

Add this import block to `src/test/extension.test.ts`:

```ts
import {
	getFrontIntelligenceSettings,
	getLegacyAliasSettings,
	DEFAULT_EXCLUDE_PATTERNS,
	DEFAULT_ALIAS_SOURCES,
} from '../config/settingsService';
```

Add this helper near the bottom of `src/test/extension.test.ts`:

```ts
function withMockedConfiguration(
	values: Record<string, unknown>,
	run: () => void
): void {
	const oldGetConfiguration = vscode.workspace.getConfiguration;
	(vscode.workspace as unknown as {
		getConfiguration: typeof vscode.workspace.getConfiguration;
	}).getConfiguration = (section?: string) => ({
		get: (key: string, defaultValue?: unknown) => {
			const fullKey = section ? `${section}.${key}` : key;
			return Object.prototype.hasOwnProperty.call(values, fullKey)
				? values[fullKey]
				: defaultValue;
		},
		has: (key: string) => {
			const fullKey = section ? `${section}.${key}` : key;
			return Object.prototype.hasOwnProperty.call(values, fullKey);
		},
		inspect: () => undefined,
		update: async () => undefined,
	} as vscode.WorkspaceConfiguration);

	try {
		run();
	} finally {
		(vscode.workspace as unknown as {
			getConfiguration: typeof vscode.workspace.getConfiguration;
		}).getConfiguration = oldGetConfiguration;
	}
}
```

Add this test inside the suite:

```ts
test('frontIntelligence settings normalize defaults and explicit aliases', () => {
	withMockedConfiguration({
		'frontIntelligence.performance.mode': 'highPerformance',
		'frontIntelligence.alias.custom': {
			'@': 'src',
			'@styles': ['src/styles', 'src/assets/styles'],
		},
	}, () => {
		const settings = getFrontIntelligenceSettings();

		assert.strictEqual(settings.enabled, true);
		assert.strictEqual(settings.performance.mode, 'highPerformance');
		assert.deepStrictEqual(settings.alias.custom['@'], ['src']);
		assert.deepStrictEqual(settings.alias.custom['@styles'], ['src/styles', 'src/assets/styles']);
		assert.deepStrictEqual(settings.alias.sources, DEFAULT_ALIAS_SOURCES);
		assert.deepStrictEqual(settings.files.exclude, DEFAULT_EXCLUDE_PATTERNS);
	});
});
```

Add this legacy compatibility test:

```ts
test('legacy aliasFileFinder aliases remain readable', () => {
	withMockedConfiguration({
		'aliasFileFinder.aliases': {
			'@legacy': 'legacy/src',
		},
	}, () => {
		assert.deepStrictEqual(getLegacyAliasSettings(), {
			'@legacy': ['legacy/src'],
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
pnpm run check-types
```

Expected: FAIL because `src/config/settingsService.ts` does not exist.

- [ ] **Step 3: Implement settings service**

Create `src/config/settingsService.ts`:

```ts
import * as vscode from 'vscode';

export type AliasSettingValue = string | string[];
export type NormalizedAliasSettings = Record<string, string[]>;
export type PerformanceMode = 'lowPower' | 'balanced' | 'highPerformance';
export type BackgroundIndexingMode = 'off' | 'auto' | 'aggressive';
export type AliasPriority = 'custom-first' | 'auto-first';

export const DEFAULT_ALIAS_SOURCES = [
	'tsconfig.json',
	'jsconfig.json',
	'vite.config.*',
	'webpack.config.*',
	'vue.config.*',
	'nuxt.config.*',
	'config.*',
];

export const DEFAULT_INCLUDE_PATTERNS = [
	'**/*.{vue,css,scss,sass,less,styl,stylus,postcss}',
];

export const DEFAULT_EXCLUDE_PATTERNS = [
	'**/node_modules/**',
	'**/dist/**',
	'**/build/**',
	'**/out/**',
	'**/.git/**',
	'**/.next/**',
	'**/.nuxt/**',
	'**/.output/**',
	'**/coverage/**',
];

export interface FrontIntelligenceSettings {
	enabled: boolean;
	performance: {
		mode: PerformanceMode;
		maxWorkers: number;
		backgroundIndexing: BackgroundIndexingMode;
	};
	files: {
		include: string[];
		exclude: string[];
	};
	alias: {
		enabled: boolean;
		autoDetect: boolean;
		sources: string[];
		custom: NormalizedAliasSettings;
		priority: AliasPriority;
		fallbacks: NormalizedAliasSettings;
	};
	css: {
		aliasNavigation: { enabled: boolean };
	};
	scss: {
		symbolNavigation: { enabled: boolean };
		bemSelector: { enabled: boolean };
	};
	vue: {
		componentNavigation: { enabled: boolean };
		componentDocs: { enabled: boolean };
		globalComponents: {
			enabled: boolean;
			paths: string[];
		};
		provideInject: { enabled: boolean };
	};
	debug: {
		logging: boolean;
		showIndexStatus: boolean;
	};
}

export function getFrontIntelligenceSettings(
	scope?: vscode.ConfigurationScope
): FrontIntelligenceSettings {
	const cfg = vscode.workspace.getConfiguration('frontIntelligence', scope);

	return {
		enabled: cfg.get<boolean>('enabled', true),
		performance: {
			mode: normalizePerformanceMode(cfg.get<string>('performance.mode', 'balanced')),
			maxWorkers: normalizeNonNegativeInteger(cfg.get<number>('performance.maxWorkers', 0)),
			backgroundIndexing: normalizeBackgroundIndexingMode(
				cfg.get<string>('performance.backgroundIndexing', 'auto')
			),
		},
		files: {
			include: normalizeStringArray(cfg.get<string[]>('files.include', DEFAULT_INCLUDE_PATTERNS)),
			exclude: normalizeStringArray(cfg.get<string[]>('files.exclude', DEFAULT_EXCLUDE_PATTERNS)),
		},
		alias: {
			enabled: cfg.get<boolean>('alias.enabled', true),
			autoDetect: cfg.get<boolean>('alias.autoDetect', true),
			sources: normalizeStringArray(cfg.get<string[]>('alias.sources', DEFAULT_ALIAS_SOURCES)),
			custom: normalizeAliasSettings(
				cfg.get<Record<string, AliasSettingValue>>('alias.custom', {})
			),
			priority: normalizeAliasPriority(cfg.get<string>('alias.priority', 'custom-first')),
			fallbacks: normalizeAliasSettings(
				cfg.get<Record<string, AliasSettingValue>>('alias.fallbacks', {
					'@': 'src',
					'~': 'src',
				})
			),
		},
		css: {
			aliasNavigation: {
				enabled: cfg.get<boolean>('css.aliasNavigation.enabled', true),
			},
		},
		scss: {
			symbolNavigation: {
				enabled: cfg.get<boolean>('scss.symbolNavigation.enabled', true),
			},
			bemSelector: {
				enabled: cfg.get<boolean>('scss.bemSelector.enabled', false),
			},
		},
		vue: {
			componentNavigation: {
				enabled: cfg.get<boolean>('vue.componentNavigation.enabled', true),
			},
			componentDocs: {
				enabled: cfg.get<boolean>('vue.componentDocs.enabled', true),
			},
			globalComponents: {
				enabled: cfg.get<boolean>('vue.globalComponents.enabled', true),
				paths: normalizeStringArray(cfg.get<string[]>('vue.globalComponents.paths', [
					'src/components/**/*.vue',
					'src/**/components/**/*.vue',
				])),
			},
			provideInject: {
				enabled: cfg.get<boolean>('vue.provideInject.enabled', true),
			},
		},
		debug: {
			logging: cfg.get<boolean>('debug.logging', false),
			showIndexStatus: cfg.get<boolean>('debug.showIndexStatus', true),
		},
	};
}

export function getLegacyAliasSettings(
	scope?: vscode.ConfigurationScope
): NormalizedAliasSettings {
	const cfg = vscode.workspace.getConfiguration('aliasFileFinder', scope);
	return normalizeAliasSettings(
		cfg.get<Record<string, AliasSettingValue>>('aliases', {})
	);
}

export function normalizeAliasSettings(
	raw: Record<string, AliasSettingValue> | undefined
): NormalizedAliasSettings {
	const out: NormalizedAliasSettings = {};
	if (!raw) {
		return out;
	}
	for (const [key, value] of Object.entries(raw)) {
		const values = Array.isArray(value) ? value : [value];
		const cleaned = values
			.filter((item): item is string => typeof item === 'string')
			.map(item => item.trim())
			.filter(Boolean);
		if (key && cleaned.length > 0) {
			out[key] = Array.from(new Set(cleaned));
		}
	}
	return out;
}

function normalizeStringArray(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === 'string')
		.map(item => item.trim())
		.filter(Boolean);
}

function normalizeNonNegativeInteger(value: number | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.floor(value));
}

function normalizePerformanceMode(value: string): PerformanceMode {
	if (value === 'lowPower' || value === 'highPerformance') {
		return value;
	}
	return 'balanced';
}

function normalizeBackgroundIndexingMode(value: string): BackgroundIndexingMode {
	if (value === 'off' || value === 'aggressive') {
		return value;
	}
	return 'auto';
}

function normalizeAliasPriority(value: string): AliasPriority {
	if (value === 'auto-first') {
		return 'auto-first';
	}
	return 'custom-first';
}
```

- [ ] **Step 4: Run tests to verify Task 1 passes**

Run:

```powershell
pnpm run check-types
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/config/settingsService.ts src/test/extension.test.ts
git commit -m "feat: add front intelligence settings service"
```

## Task 2: Add Performance Profile Resolver

**Files:**

- Create: `src/core/performanceScheduler.ts`
- Test: `src/test/extension.test.ts`

- [ ] **Step 1: Write failing tests for performance profiles**

Add this import:

```ts
import { resolvePerformanceProfile } from '../core/performanceScheduler';
```

Add these tests:

```ts
test('performance profile resolves balanced defaults', () => {
	const profile = resolvePerformanceProfile({
		mode: 'balanced',
		maxWorkers: 0,
		backgroundIndexing: 'auto',
	});

	assert.strictEqual(profile.mode, 'balanced');
	assert.ok(profile.workerCount >= 1);
	assert.strictEqual(profile.backgroundIndexing, 'auto');
	assert.strictEqual(profile.batchSize, 40);
});

test('performance profile honors explicit maxWorkers', () => {
	const profile = resolvePerformanceProfile({
		mode: 'highPerformance',
		maxWorkers: 3,
		backgroundIndexing: 'auto',
	});

	assert.strictEqual(profile.workerCount, 3);
	assert.strictEqual(profile.backgroundIndexing, 'aggressive');
	assert.strictEqual(profile.batchSize, 80);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
pnpm run check-types
```

Expected: FAIL because `src/core/performanceScheduler.ts` does not exist.

- [ ] **Step 3: Implement performance profile resolver**

Create `src/core/performanceScheduler.ts`:

```ts
import * as os from 'os';
import type { BackgroundIndexingMode, PerformanceMode } from '../config/settingsService';

export interface RawPerformanceSettings {
	mode: PerformanceMode;
	maxWorkers: number;
	backgroundIndexing: BackgroundIndexingMode;
}

export interface ResolvedPerformanceProfile {
	mode: PerformanceMode;
	workerCount: number;
	backgroundIndexing: BackgroundIndexingMode;
	batchSize: number;
	idleDelayMs: number;
}

export function resolvePerformanceProfile(
	settings: RawPerformanceSettings
): ResolvedPerformanceProfile {
	const cpuCount = Math.max(1, os.cpus().length || 1);
	const automaticWorkers = automaticWorkerCount(settings.mode, cpuCount);
	const workerCount = settings.maxWorkers > 0
		? Math.min(settings.maxWorkers, Math.max(1, cpuCount))
		: automaticWorkers;

	return {
		mode: settings.mode,
		workerCount,
		backgroundIndexing: resolveBackgroundIndexing(settings),
		batchSize: resolveBatchSize(settings.mode),
		idleDelayMs: resolveIdleDelay(settings.mode),
	};
}

function automaticWorkerCount(mode: PerformanceMode, cpuCount: number): number {
	switch (mode) {
		case 'lowPower':
			return 1;
		case 'highPerformance':
			return Math.max(2, Math.min(cpuCount - 1, 8));
		case 'balanced':
			return Math.max(1, Math.min(Math.ceil(cpuCount / 3), 4));
	}
}

function resolveBackgroundIndexing(
	settings: RawPerformanceSettings
): BackgroundIndexingMode {
	if (settings.backgroundIndexing !== 'auto') {
		return settings.backgroundIndexing;
	}
	if (settings.mode === 'lowPower') {
		return 'off';
	}
	if (settings.mode === 'highPerformance') {
		return 'aggressive';
	}
	return 'auto';
}

function resolveBatchSize(mode: PerformanceMode): number {
	switch (mode) {
		case 'lowPower':
			return 15;
		case 'highPerformance':
			return 80;
		case 'balanced':
			return 40;
	}
}

function resolveIdleDelay(mode: PerformanceMode): number {
	switch (mode) {
		case 'lowPower':
			return 1000;
		case 'highPerformance':
			return 100;
		case 'balanced':
			return 350;
	}
}
```

- [ ] **Step 4: Run tests to verify Task 2 passes**

Run:

```powershell
pnpm run check-types
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```powershell
git add src/core/performanceScheduler.ts src/test/extension.test.ts
git commit -m "feat: add performance profile resolver"
```

## Task 3: Refactor Alias Resolver Settings Flow

**Files:**

- Modify: `src/config/aliasResolver.ts`
- Test: `src/test/extension.test.ts`

- [ ] **Step 1: Write failing alias resolver tests**

Add this import:

```ts
import { clearAliasCache, getAliases } from '../config/aliasResolver';
```

Add this helper:

```ts
function createWorkspaceFolder(root: string): vscode.WorkspaceFolder {
	return {
		uri: vscode.Uri.file(root),
		name: 'workspace',
		index: 0,
	};
}
```

Add this test:

```ts
test('alias resolver prefers frontIntelligence custom aliases over auto aliases', () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'front-intelligence-alias-'));
	fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
	fs.mkdirSync(path.join(tempRoot, 'custom-src'), { recursive: true });
	fs.writeFileSync(path.join(tempRoot, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			baseUrl: '.',
			paths: {
				'@/*': ['src/*'],
			},
		},
	}));

	withMockedConfiguration({
		'frontIntelligence.alias.custom': {
			'@': 'custom-src',
		},
	}, () => {
		clearAliasCache();
		const aliases = getAliases(createWorkspaceFolder(tempRoot));
		assert.deepStrictEqual(aliases['@'], [
			path.join(tempRoot, 'custom-src'),
			path.join(tempRoot, 'src'),
		]);
	});

	fs.rmSync(tempRoot, { recursive: true, force: true });
});
```

Add alias disable test:

```ts
test('alias resolver returns no aliases when alias feature is disabled', () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'front-intelligence-alias-disabled-'));
	fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });

	withMockedConfiguration({
		'frontIntelligence.alias.enabled': false,
	}, () => {
		clearAliasCache();
		assert.deepStrictEqual(getAliases(createWorkspaceFolder(tempRoot)), {});
	});

	fs.rmSync(tempRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
pnpm test
```

Expected: FAIL because `aliasResolver` does not read `frontIntelligence.alias.custom`.

- [ ] **Step 3: Update alias resolver imports and merge flow**

In `src/config/aliasResolver.ts`, add:

```ts
import {
	getFrontIntelligenceSettings,
	getLegacyAliasSettings,
	type NormalizedAliasSettings,
} from './settingsService';
```

Replace the top of `getAliases` after cache lookup with:

```ts
	const settings = getFrontIntelligenceSettings(workspaceFolder.uri);
	if (!settings.enabled || !settings.alias.enabled) {
		cache.set(cwd, { aliases: {} });
		return {};
	}

	const aliases: AliasMap = {};
	const customAliases = resolveConfiguredAliases(settings.alias.custom, cwd);
	const legacyAliases = resolveConfiguredAliases(getLegacyAliasSettings(workspaceFolder.uri), cwd);
	const autoAliases = settings.alias.autoDetect
		? readAutoAliases(cwd, settings.alias.sources)
		: {};
	const fallbackAliases = resolveExistingFallbackAliases(settings.alias.fallbacks, cwd);

	if (settings.alias.priority === 'auto-first') {
		mergeAliases(aliases, autoAliases);
		mergeAliases(aliases, legacyAliases);
		mergeAliases(aliases, customAliases);
	} else {
		mergeAliases(aliases, legacyAliases);
		mergeAliases(aliases, customAliases);
		mergeAliases(aliases, autoAliases);
	}
	mergeAliases(aliases, fallbackAliases);
```

Remove the old calls to:

```ts
mergeAliases(aliases, readFromUserSettings(workspaceFolder));
mergeAliases(aliases, readFromTsConfig(cwd));
mergeAliases(aliases, readFromViteConfig(cwd));
mergeAliases(aliases, readFromWebpackConfig(cwd));
mergeAliases(aliases, readFromNuxtConfig(cwd));
mergeAliases(aliases, readFromVueCliConfig(cwd));
ensureCommonDefaults(aliases, cwd);
```

- [ ] **Step 4: Add resolver helper functions**

Add these functions below `mergeAliases`:

```ts
function resolveConfiguredAliases(raw: NormalizedAliasSettings, cwd: string): AliasMap {
	const out: AliasMap = {};
	for (const [key, values] of Object.entries(raw)) {
		out[key] = values.map(p => resolveToAbs(p, cwd));
	}
	return out;
}

function resolveExistingFallbackAliases(raw: NormalizedAliasSettings, cwd: string): AliasMap {
	const out: AliasMap = {};
	for (const [key, values] of Object.entries(raw)) {
		const resolved = values
			.map(p => resolveToAbs(p, cwd))
			.filter(p => fs.existsSync(p));
		if (resolved.length > 0) {
			out[key] = resolved;
		}
	}
	return out;
}

function readAutoAliases(cwd: string, sources: string[]): AliasMap {
	const out: AliasMap = {};
	if (isAliasSourceEnabled(sources, 'tsconfig.json')) {
		mergeAliases(out, readFromTsConfig(cwd, ['tsconfig.json']));
	}
	if (isAliasSourceEnabled(sources, 'jsconfig.json')) {
		mergeAliases(out, readFromTsConfig(cwd, ['jsconfig.json']));
	}
	if (isAliasSourceEnabled(sources, 'vite.config.*')) {
		mergeAliases(out, readFromViteConfig(cwd));
	}
	if (isAliasSourceEnabled(sources, 'webpack.config.*')) {
		mergeAliases(out, readFromWebpackConfig(cwd));
	}
	if (isAliasSourceEnabled(sources, 'nuxt.config.*')) {
		mergeAliases(out, readFromNuxtConfig(cwd));
	}
	if (isAliasSourceEnabled(sources, 'vue.config.*')) {
		mergeAliases(out, readFromVueCliConfig(cwd));
	}
	if (isAliasSourceEnabled(sources, 'config.*')) {
		mergeAliases(out, readFromGenericConfig(cwd));
	}
	return out;
}

function isAliasSourceEnabled(sources: string[], source: string): boolean {
	return sources.includes(source);
}
```

Change `readFromTsConfig` signature to:

```ts
function readFromTsConfig(cwd: string, candidates = ['tsconfig.json', 'jsconfig.json']): AliasMap {
```

Add a generic config reader:

```ts
function readFromGenericConfig(cwd: string): AliasMap {
	const out: AliasMap = {};
	const candidates = [
		'config.ts',
		'config.js',
		'config.mts',
		'config.mjs',
		'config.cts',
		'config.cjs',
	];
	for (const name of candidates) {
		const full = path.join(cwd, name);
		const raw = safeReadFile(full);
		if (!raw) {
			continue;
		}
		mergeAliases(out, parseAliasFromJsSource(raw, cwd));
	}
	return out;
}
```

Remove the old `readFromUserSettings` and `ensureCommonDefaults` functions after confirming no references remain.

- [ ] **Step 5: Run tests to verify Task 3 passes**

Run:

```powershell
pnpm run check-types
pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```powershell
git add src/config/aliasResolver.ts src/config/settingsService.ts src/test/extension.test.ts
git commit -m "feat: support front intelligence alias settings"
```

## Task 4: Update Extension Manifest and Commands

**Files:**

- Modify: `package.json`
- Modify: `src/extension.ts`
- Test: `src/test/extension.test.ts`

- [ ] **Step 1: Update package metadata and configuration**

In `package.json`, update:

```json
"displayName": "Front Intelligence",
"description": "性能优先的 Vue/CSS 前端代码智能补强：支持路径别名、CSS 预处理器跳转、Vue 全局组件、组件文档与 provide/inject 识别。"
```

Replace `contributes.commands` with:

```json
[
  {
    "command": "frontIntelligence.clearCache",
    "title": "Front Intelligence: 清除缓存"
  },
  {
    "command": "frontIntelligence.showResolvedAliases",
    "title": "Front Intelligence: 显示已解析别名"
  },
  {
    "command": "frontIntelligence.showIndexStatus",
    "title": "Front Intelligence: 显示索引状态"
  },
  {
    "command": "alias-file-finder.clearCache",
    "title": "Alias File Finder: 清除别名缓存"
  }
]
```

Add these configuration properties while keeping `aliasFileFinder.aliases`:

```json
"frontIntelligence.enabled": {
  "type": "boolean",
  "default": true,
  "description": "启用 Front Intelligence 的所有补强能力。"
},
"frontIntelligence.performance.mode": {
  "type": "string",
  "default": "balanced",
  "enum": ["lowPower", "balanced", "highPerformance"],
  "description": "性能模式。lowPower 更保守，balanced 为默认，highPerformance 更积极地使用设备性能。"
},
"frontIntelligence.performance.maxWorkers": {
  "type": "number",
  "default": 0,
  "minimum": 0,
  "description": "最大并发 worker 数。0 表示根据性能模式自动判断。"
},
"frontIntelligence.performance.backgroundIndexing": {
  "type": "string",
  "default": "auto",
  "enum": ["off", "auto", "aggressive"],
  "description": "后台索引策略。"
},
"frontIntelligence.alias.enabled": {
  "type": "boolean",
  "default": true,
  "description": "启用路径别名解析。"
},
"frontIntelligence.alias.autoDetect": {
  "type": "boolean",
  "default": true,
  "description": "自动读取 tsconfig、jsconfig、vite、webpack、vue、nuxt、config 等配置中的 alias。"
},
"frontIntelligence.alias.sources": {
  "type": "array",
  "default": ["tsconfig.json", "jsconfig.json", "vite.config.*", "webpack.config.*", "vue.config.*", "nuxt.config.*", "config.*"],
  "items": { "type": "string" },
  "description": "允许自动读取 alias 的配置来源。"
},
"frontIntelligence.alias.custom": {
  "type": "object",
  "default": {},
  "description": "自定义路径别名。键为别名，值为相对工作区根目录的路径、绝对路径，或路径数组。",
  "additionalProperties": {
    "oneOf": [
      { "type": "string" },
      { "type": "array", "items": { "type": "string" } }
    ]
  }
},
"frontIntelligence.alias.priority": {
  "type": "string",
  "default": "custom-first",
  "enum": ["custom-first", "auto-first"],
  "description": "自定义别名和自动检测别名冲突时的优先级。"
},
"frontIntelligence.alias.fallbacks": {
  "type": "object",
  "default": { "@": "src", "~": "src" },
  "description": "自动检测和自定义配置都未命中时使用的别名兜底。仅在目标路径存在时生效。"
}
```

- [ ] **Step 2: Register new commands in extension**

In `src/extension.ts`, import:

```ts
import { getAliases } from './config/aliasResolver';
```

Add a helper inside `activate`:

```ts
	const clearAllCaches = () => {
		clearAliasCache();
		clearVueParserCache();
		vueProvideInjectIndex.invalidate();
	};
```

Replace the current config change handler with:

```ts
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (
                e.affectsConfiguration('aliasFileFinder') ||
                e.affectsConfiguration('frontIntelligence')
            ) {
                clearAliasCache();
            }
        })
    );
```

Replace the old clear-cache command registration with:

```ts
	const registerClearCacheCommand = (command: string) =>
		vscode.commands.registerCommand(command, () => {
			clearAllCaches();
			vscode.window.showInformationMessage('Front Intelligence：缓存已清除');
		});

	context.subscriptions.push(registerClearCacheCommand('frontIntelligence.clearCache'));
	context.subscriptions.push(registerClearCacheCommand('alias-file-finder.clearCache'));
	context.subscriptions.push(
		vscode.commands.registerCommand('frontIntelligence.showResolvedAliases', () => {
			const folders = vscode.workspace.workspaceFolders || [];
			if (folders.length === 0) {
				vscode.window.showInformationMessage('Front Intelligence：当前没有打开工作区文件夹');
				return;
			}
			const lines = folders.flatMap(folder => {
				const aliases = getAliases(folder);
				const entries = Object.entries(aliases);
				if (entries.length === 0) {
					return [`${folder.name}: 未解析到路径别名`];
				}
				return [
					`${folder.name}:`,
					...entries.map(([key, values]) => `  ${key} -> ${values.join(', ')}`),
				];
			});
			vscode.window.showInformationMessage(lines.join('\n'));
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('frontIntelligence.showIndexStatus', () => {
			vscode.window.showInformationMessage('Front Intelligence：索引按需加载，当前版本提供别名和 Vue 缓存状态命令。');
		})
	);
```

- [ ] **Step 3: Run manifest and extension tests**

Run:

```powershell
pnpm run check-types
pnpm run lint
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit Task 4**

Run:

```powershell
git add package.json src/extension.ts
git commit -m "feat: add front intelligence configuration surface"
```

## Task 5: Documentation and Verification

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Replace README with product positioning and configuration examples**

Use this README content:

```md
# Front Intelligence

Front Intelligence is a performance-first VS Code extension that supplements Vue and CSS-preprocessor project intelligence.

It helps with:

- CSS/SCSS/SASS/LESS/Stylus/PostCSS alias imports.
- Alias imports inside Vue/Svelte/Astro/HTML style blocks.
- Vue global component file navigation.
- Vue component JSDoc, props, and emits hover/completion metadata.
- Vue provide/inject string-key navigation.

The extension is designed to stay responsive on low-performance machines and to use higher-performance machines for faster background indexing.

## Alias Resolution

Aliases are detected automatically from:

- `tsconfig.json`
- `jsconfig.json`
- `vite.config.*`
- `webpack.config.*`
- `vue.config.*`
- `nuxt.config.*`
- `config.*`

You can also define aliases manually:

```json
{
  "frontIntelligence.alias.custom": {
    "@": "src",
    "@components": "src/components",
    "@styles": ["src/styles", "src/assets/styles"]
  }
}
```

Manual aliases are preferred by default. The old `aliasFileFinder.aliases` setting is still supported for compatibility.

## Performance

```json
{
  "frontIntelligence.performance.mode": "balanced"
}
```

Available modes:

- `lowPower`: minimal background work and conservative concurrency.
- `balanced`: default lazy indexing with idle background work.
- `highPerformance`: more aggressive background indexing and higher concurrency.

## Commands

- `Front Intelligence: 清除缓存`
- `Front Intelligence: 显示已解析别名`
- `Front Intelligence: 显示索引状态`
```

- [ ] **Step 2: Update changelog**

Add under `[Unreleased]`:

```md
- Reposition the extension as Front Intelligence.
- Add the `frontIntelligence` configuration namespace.
- Add custom-first alias settings with automatic alias detection from common frontend config files.
- Add performance profile scaffolding for low power, balanced, and high performance modes.
- Keep compatibility with `aliasFileFinder.aliases` and `alias-file-finder.clearCache`.
```

- [ ] **Step 3: Run final verification**

Run:

```powershell
pnpm run check-types
pnpm run lint
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit Task 5**

Run:

```powershell
git add README.md CHANGELOG.md
git commit -m "docs: document front intelligence configuration"
```

## Final Verification

- [ ] **Step 1: Confirm working tree contains only unrelated pre-existing changes**

Run:

```powershell
git status --short
```

Expected: Any remaining modified files are pre-existing changes that were not part of this implementation or are intentionally left for the next phase.

- [ ] **Step 2: Run package build**

Run:

```powershell
pnpm run package
```

Expected: PASS and `dist/extension.js` updates if build output is tracked or present locally.

- [ ] **Step 3: Summarize Phase 0/1 result**

Report:

- New settings service added.
- Alias resolver supports new and legacy configuration.
- Performance profile resolver added.
- Manifest exposes new configuration and commands.
- Tests and package build pass.
