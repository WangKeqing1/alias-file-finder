import * as vscode from 'vscode';
import { affLog } from '../affLog';
import { fsPathToOpenUri, isHttpUrl, resolveReferencePath } from '../utils/fileFinder';

const SUPPORTED_LANGS = new Set([
    'css',
    'scss',
    'sass',
    'less',
    'postcss',
    'stylus',
    'vue',
    'svelte',
    'astro',
    'html',
]);

/**
 * 匹配下列形式（不含字符串引号）:
 *   @import "xxx";
 *   @import 'xxx';
 *   @import url("xxx");
 *   @import url('xxx');
 *   @import url(xxx);
 *   @use "xxx";
 *   @forward "xxx";
 *   @require "xxx";   (less)
 *   @import-once "xxx";
 *
 * 也兼容 sass 缩进语法（无分号）。
 */
const IMPORT_REGEX =
    /@(?:import|use|forward|require|import-once)\s+(?:url\(\s*)?(?:(['"])([^'"\n]+)\1|([^\s'"();]+))\s*\)?/g;

interface ParsedImport {
    raw: string;            // 原始 spec
    startOffset: number;    // 在整个文档中的偏移
    endOffset: number;
}

function findImportsInBlock(blockText: string, blockOffset: number): ParsedImport[] {
    const results: ParsedImport[] = [];
    const regex = new RegExp(IMPORT_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = regex.exec(blockText))) {
        const quoted = m[2];
        const unquoted = m[3];
        const spec = quoted ?? unquoted;
        if (!spec) {
            continue;
        }
        // 在 m[0] 中再找一次准确位置
        const inMatchIdx = m[0].indexOf(spec);
        if (inMatchIdx === -1) {
            continue;
        }
        const start = blockOffset + m.index + inMatchIdx;
        results.push({
            raw: spec,
            startOffset: start,
            endOffset: start + spec.length,
        });
    }
    return results;
}

/**
 * 从 vue / html / svelte 文档中提取 <style> 块及其在整篇文档中的偏移。
 */
function extractStyleBlocks(text: string): { content: string; offset: number }[] {
    const out: { content: string; offset: number }[] = [];
    const regex = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text))) {
        const fullStart = m.index;
        const openTag = m[0].substring(0, m[0].indexOf('>') + 1);
        const contentStart = fullStart + openTag.length;
        out.push({
            content: m[1],
            offset: contentStart,
        });
    }
    return out;
}

function isStyleHostLanguage(langId: string): boolean {
    return langId === 'vue' || langId === 'svelte' || langId === 'astro' || langId === 'html';
}

function collectImports(document: vscode.TextDocument): ParsedImport[] {
    if (isStyleHostLanguage(document.languageId)) {
        const text = document.getText();
        const blocks = extractStyleBlocks(text);
        const all: ParsedImport[] = [];
        for (const b of blocks) {
            all.push(...findImportsInBlock(b.content, b.offset));
        }
        return all;
    }
    return findImportsInBlock(document.getText(), 0);
}

function extensionsForLanguage(langId: string): string[] {
    switch (langId) {
        case 'less':
            return ['.less', '.css'];
        case 'sass':
        case 'scss':
            return ['.scss', '.sass', '.css'];
        case 'stylus':
            return ['.styl', '.stylus', '.css'];
        case 'postcss':
        case 'css':
            return ['.css', '.scss', '.sass', '.less'];
        default:
            // vue / html / svelte / astro：style 块语言不确定，全部尝试
            return ['.scss', '.sass', '.less', '.styl', '.stylus', '.css'];
    }
}

function shouldTryPartial(langId: string): boolean {
    return langId === 'scss' || langId === 'sass' || langId === 'vue' || langId === 'html' || langId === 'svelte' || langId === 'astro';
}

function shouldResolveStyleSpec(spec: string): boolean {
    return !/^sass:/i.test(spec.trim());
}

export class CssLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentLink[]> {
        if (!SUPPORTED_LANGS.has(document.languageId)) {
            affLog('css:links:skip-lang', document.languageId, document.uri.toString());
            return [];
        }
        const ws = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!ws) {
            affLog('css:links:no-workspace', {
                uri: document.uri.toString(),
                fsPath: document.uri.fsPath,
                scheme: document.uri.scheme,
                hint: '未打开文件夹或多根工作区下文件未映射到文件夹时，getWorkspaceFolder 可能为 undefined，别名解析会失败',
            });
            return [];
        }

        const imports = collectImports(document);
        affLog('css:links', {
            file: document.uri.fsPath,
            languageId: document.languageId,
            workspaceFolder: ws.uri.fsPath,
            importCount: imports.length,
        });
        const links: vscode.DocumentLink[] = [];

        for (const imp of imports) {
            const range = new vscode.Range(
                document.positionAt(imp.startOffset),
                document.positionAt(imp.endOffset)
            );
            if (isHttpUrl(imp.raw)) {
                const url = imp.raw.startsWith('//') ? 'https:' + imp.raw : imp.raw;
                const link = new vscode.DocumentLink(range, vscode.Uri.parse(url));
                link.tooltip = '在浏览器中打开';
                links.push(link);
                continue;
            }
            if (!shouldResolveStyleSpec(imp.raw)) {
                continue;
            }

            const target = resolveReferencePath(imp.raw, {
                fromFile: document.uri.fsPath,
                workspaceFolder: ws,
                extensions: extensionsForLanguage(document.languageId),
                tryPartial: shouldTryPartial(document.languageId),
                tryIndex: true,
            });

            if (target) {
                const targetUri = fsPathToOpenUri(target, ws);
                const link = new vscode.DocumentLink(range, targetUri);
                link.tooltip = `打开 ${targetUri.fsPath}`;
                links.push(link);
            } else if (!isHttpUrl(imp.raw)) {
                affLog('css:links:unresolved', { raw: imp.raw, file: document.uri.fsPath });
            }
        }

        return links;
    }
}

/**
 * 同时提供 Definition（Ctrl+点击 / F12）作为兜底。
 * 部分用户偏好用跳转定义而非链接的方式打开文件。
 */
export class CssDefinitionProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        if (!SUPPORTED_LANGS.has(document.languageId)) {
            return undefined;
        }
        const ws = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!ws) {
            affLog('css:definition:no-workspace', document.uri.toString());
            return undefined;
        }
        const imports = collectImports(document);
        const offset = document.offsetAt(position);
        const hit = imports.find(i => offset >= i.startOffset && offset <= i.endOffset);
        if (!hit) {
            return undefined;
        }
        if (isHttpUrl(hit.raw)) {
            return undefined;
        }
        if (!shouldResolveStyleSpec(hit.raw)) {
            return undefined;
        }
        affLog('css:definition', { raw: hit.raw, file: document.uri.fsPath, workspace: ws.uri.fsPath });
        const target = resolveReferencePath(hit.raw, {
            fromFile: document.uri.fsPath,
            workspaceFolder: ws,
            extensions: extensionsForLanguage(document.languageId),
            tryPartial: shouldTryPartial(document.languageId),
            tryIndex: true,
        });
        if (!target) {
            affLog('css:definition:miss', { raw: hit.raw });
            return undefined;
        }
        return new vscode.Location(fsPathToOpenUri(target, ws), new vscode.Position(0, 0));
    }
}

export const CSS_PROVIDER_SELECTORS: vscode.DocumentSelector = [
    { language: 'css', scheme: 'file' },
    { language: 'scss', scheme: 'file' },
    { language: 'sass', scheme: 'file' },
    { language: 'less', scheme: 'file' },
    { language: 'postcss', scheme: 'file' },
    { language: 'stylus', scheme: 'file' },
    { language: 'vue', scheme: 'file' },
    { language: 'svelte', scheme: 'file' },
    { language: 'astro', scheme: 'file' },
    { language: 'html', scheme: 'file' },
];
