import * as vscode from 'vscode';
import type { VueProvideInjectIndex } from './vueProvideInjectIndex';
import { scanVueProvideInjectKeys } from '../utils/vueProvideInjectScan';

/**
 * 在 inject 的字符串键上跳转到对应 provide 定义位置。
 */
export class VueInjectDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly index: VueProvideInjectIndex) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
        if (document.languageId !== 'vue') {
            return undefined;
        }
        await this.index.ensureReady();
        const offset = document.offsetAt(position);
        const text = document.getText();
        const sites = scanVueProvideInjectKeys(text);
        for (const s of sites) {
            if (s.kind !== 'inject') {
                continue;
            }
            if (offset < s.start || offset >= s.end) {
                continue;
            }
            const targets = this.index.findProvideLocations(s.key);
            if (targets.length === 0) {
                return undefined;
            }
            const originSelectionRange = new vscode.Range(
                document.positionAt(s.start),
                document.positionAt(s.end)
            );
            return targets.map<vscode.LocationLink>(t => ({
                originSelectionRange,
                targetUri: t.uri,
                targetRange: t.range,
                targetSelectionRange: t.range,
            }));
        }
        return undefined;
    }
}

/**
 * 在 provide 的键上查找所有 inject 引用（查找所有引用 / Shift+F12）。
 */
export class VueProvideReferenceProvider implements vscode.ReferenceProvider {
    constructor(private readonly index: VueProvideInjectIndex) {}

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        if (document.languageId !== 'vue') {
            return undefined;
        }
        await this.index.ensureReady();
        const offset = document.offsetAt(position);
        const text = document.getText();
        const sites = scanVueProvideInjectKeys(text);
        for (const s of sites) {
            if (s.kind !== 'provide') {
                continue;
            }
            if (offset < s.start || offset >= s.end) {
                continue;
            }
            const refs = this.index.findInjectLocations(s.key);
            return refs.length > 0 ? refs : undefined;
        }
        return undefined;
    }
}
