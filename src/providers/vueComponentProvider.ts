import * as vscode from 'vscode';
import * as path from 'path';

const HTML_NATIVE_TAGS = new Set([
    'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi',
    'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code',
    'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog',
    'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer',
    'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
    'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li',
    'link', 'main', 'map', 'mark', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
    'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress', 'q',
    'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'script', 'section', 'select', 'slot',
    'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table',
    'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr',
    'track', 'u', 'ul', 'var', 'video', 'wbr',
    // SVG
    'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
    'text', 'tspan', 'use', 'defs', 'symbol', 'mask', 'pattern', 'clippath', 'image',
    'foreignobject',
    // Vue 内置
    'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense', 'component',
]);

export interface IndexEntry {
    /** 文件名（不含扩展） */
    name: string;
    /** PascalCase 形式 */
    pascal: string;
    /** kebab-case 形式 */
    kebab: string;
    uri: vscode.Uri;
}

export class VueComponentIndex implements vscode.Disposable {
    private entries: IndexEntry[] = [];
    private byPascal = new Map<string, IndexEntry[]>();
    private byKebab = new Map<string, IndexEntry[]>();
    private watcher?: vscode.FileSystemWatcher;
    private ready: Promise<void> | null = null;

    async ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = this.rebuild();
        }
        return this.ready;
    }

    initialize(): void {
        this.ready = this.rebuild();
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.vue');
        this.watcher.onDidCreate(uri => this.addEntry(uri));
        this.watcher.onDidDelete(uri => this.removeEntry(uri));
        this.watcher.onDidChange(() => { /* 文件名没变化时不影响索引 */ });
    }

    dispose(): void {
        this.watcher?.dispose();
    }

    private async rebuild(): Promise<void> {
        this.entries = [];
        this.byPascal.clear();
        this.byKebab.clear();
        try {
            const uris = await vscode.workspace.findFiles(
                '**/*.vue',
                '**/{node_modules,dist,build,out,.git,.next,.nuxt,.output,coverage}/**',
                5000
            );
            for (const uri of uris) {
                this.addEntry(uri);
            }
        } catch {
            // ignore
        }
    }

    private addEntry(uri: vscode.Uri): void {
        const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
        if (!base) {
            return;
        }
        const pascal = toPascalCase(base);
        const kebab = toKebabCase(base);
        const entry: IndexEntry = { name: base, pascal, kebab, uri };
        this.entries.push(entry);
        pushToMap(this.byPascal, pascal, entry);
        pushToMap(this.byKebab, kebab, entry);
    }

    private removeEntry(uri: vscode.Uri): void {
        const fs = uri.fsPath;
        this.entries = this.entries.filter(e => e.uri.fsPath !== fs);
        for (const map of [this.byPascal, this.byKebab]) {
            for (const [k, list] of map) {
                const filtered = list.filter(e => e.uri.fsPath !== fs);
                if (filtered.length === 0) {
                    map.delete(k);
                } else {
                    map.set(k, filtered);
                }
            }
        }
    }

    findByTag(tagName: string): IndexEntry[] {
        const pascal = toPascalCase(tagName);
        const kebab = toKebabCase(tagName);

        const seen = new Set<string>();
        const results: IndexEntry[] = [];
        const push = (list?: IndexEntry[]) => {
            if (!list) { return; }
            for (const e of list) {
                if (!seen.has(e.uri.fsPath)) {
                    seen.add(e.uri.fsPath);
                    results.push(e);
                }
            }
        };
        push(this.byPascal.get(pascal));
        push(this.byKebab.get(kebab));
        return results;
    }
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

function toPascalCase(str: string): string {
    return str
        .replace(/[_\-\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
        .replace(/^(.)/, c => c.toUpperCase());
}

function toKebabCase(str: string): string {
    return str
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

/**
 * 在 Vue 文件中，找到光标处的"组件标签名"。
 * 仅当：
 *  - 光标位于 <template> 块中
 *  - 光标处是某个标签的开标签或闭标签名
 * 时返回 { tagName, range }。
 */
export function findTagAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): { tagName: string; range: vscode.Range } | null {
    const text = document.getText();

    // 1. 定位 template 块
    const templateBlocks = extractTemplateBlocks(text);
    const offset = document.offsetAt(position);
    const inTemplate = templateBlocks.find(b => offset >= b.start && offset <= b.end);
    if (!inTemplate) {
        return null;
    }

    // 2. 在 template 块文本中找到包含光标的标签
    const blockText = text.substring(inTemplate.start, inTemplate.end);
    const blockOffset = offset - inTemplate.start;

    // 标签匹配：< / 可选 + 标签名 + （后续属性...或 / 或 >）
    const tagRegex = /<\/?([A-Za-z][A-Za-z0-9_\-.]*)/g;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(blockText))) {
        const tagName = m[1];
        // 名称起点
        const slash = m[0].startsWith('</') ? 2 : 1;
        const nameStartInBlock = m.index + slash;
        const nameEndInBlock = nameStartInBlock + tagName.length;
        if (blockOffset >= nameStartInBlock && blockOffset <= nameEndInBlock) {
            const startGlobal = inTemplate.start + nameStartInBlock;
            const endGlobal = inTemplate.start + nameEndInBlock;
            return {
                tagName,
                range: new vscode.Range(
                    document.positionAt(startGlobal),
                    document.positionAt(endGlobal)
                ),
            };
        }
        if (nameStartInBlock > blockOffset) {
            break; // 已经越过光标
        }
    }
    return null;
}

function extractTemplateBlocks(text: string): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    const regex = /<template\b[^>]*>([\s\S]*?)<\/template\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text))) {
        // 注意：组件标签可能也叫 <template>（vue 内置），但这里我们处理的是 SFC 顶层 template。
        // SFC 的顶层 template 通常在文件根部。简单起见，全部 <template> 都视为 template 块。
        // 这样即便嵌套 template 也只是多走一次正则，不影响功能。
        const open = m[0].substring(0, m[0].indexOf('>') + 1);
        const contentStart = m.index + open.length;
        const contentEnd = m.index + m[0].length - '</template>'.length;
        out.push({ start: contentStart, end: contentEnd });
    }
    return out;
}

export function isLikelyComponent(tagName: string): boolean {
    if (!tagName) {
        return false;
    }
    if (HTML_NATIVE_TAGS.has(tagName.toLowerCase())) {
        return false;
    }
    // 包含 dot 表示命名空间或组件成员访问：跳过（如 router-view 等仍可走 kebab 检测）
    if (tagName.includes('.')) {
        return false;
    }
    // 以大写字母开头 -> PascalCase 组件
    if (/^[A-Z]/.test(tagName)) {
        return true;
    }
    // 含有 - 且不在原生标签集合中 -> 视为 web component / vue 组件
    if (tagName.includes('-')) {
        return true;
    }
    return false;
}

export class VueComponentDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly index: VueComponentIndex) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
        if (document.languageId !== 'vue') {
            return undefined;
        }
        const hit = findTagAtPosition(document, position);
        if (!hit) {
            return undefined;
        }
        if (!isLikelyComponent(hit.tagName)) {
            return undefined;
        }
        await this.index.ensureReady();
        const matches = this.index.findByTag(hit.tagName);
        if (matches.length === 0) {
            return undefined;
        }

        const originSelectionRange = hit.range;
        return matches.map<vscode.LocationLink>(m => ({
            originSelectionRange,
            targetUri: m.uri,
            targetRange: new vscode.Range(0, 0, 0, 0),
        }));
    }
}

export function createVueComponentIndex(): VueComponentIndex {
    const idx = new VueComponentIndex();
    idx.initialize();
    return idx;
}

export const VUE_PROVIDER_SELECTOR: vscode.DocumentSelector = [
    { language: 'vue', scheme: 'file' },
];
