import * as assert from 'assert';

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
