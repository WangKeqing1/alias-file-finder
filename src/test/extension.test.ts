import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';
import {
	getFrontIntelligenceSettings,
	getLegacyAliasSettings,
	DEFAULT_EXCLUDE_PATTERNS,
	DEFAULT_ALIAS_SOURCES,
} from '../config/settingsService';
import { resolvePerformanceProfile } from '../core/performanceScheduler';
import { clearAliasCache, getAliases } from '../config/aliasResolver';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

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

		try {
			const folder = createWorkspaceFolder(tempRoot);
			const root = folder.uri.fsPath;
			withMockedConfiguration({
				'frontIntelligence.alias.custom': {
					'@': 'custom-src',
				},
			}, () => {
				clearAliasCache();
				const aliases = getAliases(folder);
				assert.deepStrictEqual(aliases['@'], [
					path.join(root, 'custom-src'),
					path.join(root, 'src'),
				]);
			});
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('alias resolver prefers frontIntelligence custom aliases over legacy aliases', () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'front-intelligence-legacy-alias-'));
		fs.mkdirSync(path.join(tempRoot, 'legacy-src'), { recursive: true });
		fs.mkdirSync(path.join(tempRoot, 'custom-src'), { recursive: true });

		try {
			const folder = createWorkspaceFolder(tempRoot);
			const root = folder.uri.fsPath;
			withMockedConfiguration({
				'frontIntelligence.alias.autoDetect': false,
				'frontIntelligence.alias.custom': {
					'@': 'custom-src',
				},
				'aliasFileFinder.aliases': {
					'@': 'legacy-src',
				},
			}, () => {
				clearAliasCache();
				const aliases = getAliases(folder);
				assert.deepStrictEqual(aliases['@'], [
					path.join(root, 'custom-src'),
					path.join(root, 'legacy-src'),
				]);
			});
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('alias resolver returns no aliases when alias feature is disabled', () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'front-intelligence-alias-disabled-'));
		fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });

		try {
			withMockedConfiguration({
				'frontIntelligence.alias.enabled': false,
			}, () => {
				clearAliasCache();
				assert.deepStrictEqual(getAliases(createWorkspaceFolder(tempRoot)), {});
			});
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

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

function createWorkspaceFolder(root: string): vscode.WorkspaceFolder {
	return {
		uri: vscode.Uri.file(root),
		name: 'workspace',
		index: 0,
	};
}
