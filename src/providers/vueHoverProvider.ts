import * as vscode from 'vscode';
import * as path from 'path';
import {
    VueComponentIndex,
    findTagAtPosition,
    isLikelyComponent,
} from './vueComponentProvider';
import {
    parseVueComponent,
    ParsedProp,
    ParsedEmit,
    ParsedVueComponent,
    toKebabCase,
} from '../utils/vueParser';

/**
 * 在 Vue 模板里的组件标签上 hover 时，展示其本地源文件中：
 *   - 组件级 JSDoc（含 @description / @example 等）
 *   - props 列表（类型 / 默认值 / 注释）
 *   - emits 列表（参数签名 / 注释）
 */
export class VueComponentHoverProvider implements vscode.HoverProvider {
    constructor(private readonly index: VueComponentIndex) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        if (document.languageId !== 'vue') {
            return undefined;
        }
        const hit = findTagAtPosition(document, position);
        if (!hit || !isLikelyComponent(hit.tagName)) {
            return undefined;
        }
        await this.index.ensureReady();
        const matches = this.index.findByTag(hit.tagName);
        if (matches.length === 0) {
            return undefined;
        }

        // 多个同名时优先选择路径最短的（一般是更"主"的那个），其余在尾部以链接形式列出
        const sorted = [...matches].sort((a, b) => a.uri.fsPath.length - b.uri.fsPath.length);
        const primary = sorted[0];
        const parsed = parseVueComponent(primary.uri.fsPath);
        if (!parsed) {
            return undefined;
        }

        const md = buildHoverMarkdown(hit.tagName, parsed, primary.uri, sorted.slice(1).map(s => s.uri));
        return new vscode.Hover(md, hit.range);
    }
}

function buildHoverMarkdown(
    tagName: string,
    parsed: ParsedVueComponent,
    primaryUri: vscode.Uri,
    otherUris: vscode.Uri[]
): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;

    const displayName = parsed.componentName || path.basename(primaryUri.fsPath, path.extname(primaryUri.fsPath));
    const fileLink = `[${vscode.workspace.asRelativePath(primaryUri)}](${primaryUri.toString()})`;
    md.appendMarkdown(`**\`<${tagName}>\`** — \`${displayName}\`  \n${fileLink}\n\n`);

    if (parsed.componentJsDoc) {
        md.appendMarkdown(renderJsDocSummary(parsed.componentJsDoc));
        md.appendMarkdown('\n\n');
    }

    if (parsed.props.length > 0) {
        md.appendMarkdown('---\n\n');
        md.appendMarkdown('**Props**\n\n');
        md.appendMarkdown(renderPropsTable(parsed.props));
        md.appendMarkdown('\n\n');
    }

    if (parsed.emits.length > 0) {
        md.appendMarkdown('---\n\n');
        md.appendMarkdown('**Emits**\n\n');
        md.appendMarkdown(renderEmitsTable(parsed.emits));
        md.appendMarkdown('\n\n');
    }

    if (otherUris.length > 0) {
        md.appendMarkdown('---\n\n');
        md.appendMarkdown('**其他同名组件**：');
        md.appendMarkdown(
            otherUris
                .map(u => `[${vscode.workspace.asRelativePath(u)}](${u.toString()})`)
                .join('  ·  ')
        );
    }

    return md;
}

/**
 * 把组件级 JSDoc 渲染成精简的概要：
 *  - 第一段非 @ 行作为说明
 *  - @description / @example 等独立处理
 */
function renderJsDocSummary(jsdoc: string): string {
    const lines = jsdoc.split('\n');
    const descLines: string[] = [];
    let inExample = false;
    const examples: string[] = [];
    let curExample: string[] = [];

    const flushExample = () => {
        if (curExample.length) {
            examples.push(curExample.join('\n'));
            curExample = [];
        }
    };

    for (const line of lines) {
        const m = line.match(/^@([a-zA-Z]+)\s*(.*)$/);
        if (m) {
            const tag = m[1].toLowerCase();
            const value = m[2];
            inExample = false;
            flushExample();
            if (tag === 'description' || tag === 'desc') {
                if (value) {
                    descLines.push(value);
                }
            } else if (tag === 'example') {
                inExample = true;
                if (value) {
                    curExample.push(value);
                }
            } else if (tag === 'component') {
                // 名字单独提示
            } else {
                descLines.push(`*@${tag}* ${value}`.trim());
            }
            continue;
        }
        if (inExample) {
            curExample.push(line);
        } else {
            descLines.push(line);
        }
    }
    flushExample();

    const out: string[] = [];
    const desc = descLines.join('\n').trim();
    if (desc) {
        out.push(desc);
    }
    for (const ex of examples) {
        const cleaned = stripExampleFence(ex).trim();
        if (cleaned) {
            out.push('**Example**');
            out.push('```vue\n' + cleaned + '\n```');
        }
    }
    return out.join('\n\n');
}

/**
 * 把 `@example` 内可能已经包含的 ```vue ... ``` 围栏去掉，避免 markdown 嵌套出错。
 */
function stripExampleFence(text: string): string {
    return text.replace(/^```[\w]*\s*/m, '').replace(/```\s*$/m, '');
}

function renderPropsTable(props: ParsedProp[]): string {
    const rows: string[] = [];
    rows.push('| 属性 | 类型 | 默认值 | 必填 | 说明 |');
    rows.push('| :-- | :-- | :-- | :--: | :-- |');
    for (const p of props) {
        const kebab = toKebabCase(p.name);
        rows.push(
            `| \`${kebab}\` | ${formatType(p.type)} | ${formatDefault(p.defaultValue)} | ${p.required ? '是' : ''} | ${formatComment(p.comment)} |`
        );
    }
    return rows.join('\n');
}

function renderEmitsTable(emits: ParsedEmit[]): string {
    const rows: string[] = [];
    rows.push('| 事件 | 参数 | 说明 |');
    rows.push('| :-- | :-- | :-- |');
    for (const e of emits) {
        const kebab = toKebabCase(e.name);
        rows.push(`| \`${kebab}\` | ${formatType(e.signature)} | ${formatComment(e.comment)} |`);
    }
    return rows.join('\n');
}

function formatType(t?: string): string {
    if (!t) {
        return '';
    }
    const escaped = escapeMdCell(t);
    return '`' + escaped + '`';
}

function formatDefault(v?: string): string {
    if (v === undefined || v === '') {
        return '';
    }
    return '`' + escapeMdCell(v) + '`';
}

function formatComment(c?: string): string {
    if (!c) {
        return '';
    }
    // 表格单元格里不允许换行，转为 <br/>
    return escapeMdCell(c).replace(/\n/g, ' <br/> ');
}

function escapeMdCell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/`/g, '\u200b`\u200b');
}
