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
