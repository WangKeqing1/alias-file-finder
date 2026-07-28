import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';
import { affLog } from '../affLog';
import { CssLinkProvider } from '../providers/cssLinkProvider';
import { createVueComponentIndex } from '../providers/vueComponentProvider';
import { createVueProvideInjectIndex } from '../providers/vueProvideInjectIndex';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('affLog is silent unless debug is explicitly enabled', () => {
		const oldDebug = process.env.ALIAS_FILE_FINDER_DEBUG;
		const oldDescriptor = Object.getOwnPropertyDescriptor(console, 'log');
		let calls = 0;

		delete process.env.ALIAS_FILE_FINDER_DEBUG;
		Object.defineProperty(console, 'log', {
			configurable: true,
			value: () => {
				calls++;
			},
		});

		try {
			affLog('test');
		} finally {
			if (oldDescriptor) {
				Object.defineProperty(console, 'log', oldDescriptor);
			}
			if (oldDebug === undefined) {
				delete process.env.ALIAS_FILE_FINDER_DEBUG;
			} else {
				process.env.ALIAS_FILE_FINDER_DEBUG = oldDebug;
			}
		}

		assert.strictEqual(calls, 0);
	});

	test('Vue component index does not scan workspace until first use', async () => {
		const oldFindFiles = vscode.workspace.findFiles;
		let calls = 0;

		(vscode.workspace as unknown as { findFiles: typeof vscode.workspace.findFiles }).findFiles = async () => {
			calls++;
			return [];
		};

		const index = createVueComponentIndex();
		try {
			assert.strictEqual(calls, 0);
			await index.ensureReady();
			assert.strictEqual(calls, 1);
		} finally {
			index.dispose();
			(vscode.workspace as unknown as { findFiles: typeof vscode.workspace.findFiles }).findFiles = oldFindFiles;
		}
	});

	test('Vue provide/inject index does not scan workspace until first use', async () => {
		const oldFindFiles = vscode.workspace.findFiles;
		let calls = 0;

		(vscode.workspace as unknown as { findFiles: typeof vscode.workspace.findFiles }).findFiles = async () => {
			calls++;
			return [];
		};

		const index = createVueProvideInjectIndex();
		try {
			assert.strictEqual(calls, 0);
			await index.ensureReady();
			assert.strictEqual(calls, 1);
		} finally {
			index.dispose();
			(vscode.workspace as unknown as { findFiles: typeof vscode.workspace.findFiles }).findFiles = oldFindFiles;
		}
	});

	test('CSS link provider ignores Sass mixin includes and built-in Sass modules', () => {
		const oldGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-file-finder-'));
		fs.writeFileSync(path.join(tempRoot, 'respond-to.scss'), '/* mixin placeholder */');

		(vscode.workspace as unknown as {
			getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder;
		}).getWorkspaceFolder = () => ({
			uri: vscode.Uri.file(tempRoot),
			name: 'workspace',
			index: 0,
		});

		const cts = new vscode.CancellationTokenSource();
		try {
			const links = new CssLinkProvider().provideDocumentLinks(
				createTextDocument('scss', [
					'@include respond-to;',
					'@use "sass:map";',
				].join('\n')),
				cts.token
			) as vscode.DocumentLink[];

			assert.strictEqual(links.length, 0);
		} finally {
			cts.dispose();
			(vscode.workspace as unknown as {
				getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder;
			}).getWorkspaceFolder = oldGetWorkspaceFolder;
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

function createTextDocument(languageId: string, text: string): vscode.TextDocument {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}

	return {
		uri: vscode.Uri.file(path.join(process.cwd(), `test.${languageId}`)),
		languageId,
		getText: () => text,
		positionAt: (offset: number) => {
			const safeOffset = Math.max(0, Math.min(offset, text.length));
			let line = 0;
			for (let i = 0; i < lineStarts.length; i++) {
				if (lineStarts[i] > safeOffset) {
					break;
				}
				line = i;
			}
			return new vscode.Position(line, safeOffset - lineStarts[line]);
		},
	} as vscode.TextDocument;
}
