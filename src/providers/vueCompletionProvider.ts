import * as vscode from 'vscode';
import * as path from 'path';
import {
    VueComponentIndex,
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
 * 在 Vue 模板里输入组件属性时提供补全：
 *
 *  <MyComp |          → 补全所有 prop 名（:prop、prop）和 emit（@emit）
 *  <MyComp :fo|       → 过滤 prop（绑定模式）
 *  <MyComp @upd|      → 过滤 emit
 *
 * 触发字符：空格、: 、@
 */
export class VueCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly index: VueComponentIndex) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _ctx: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | undefined> {
        if (document.languageId !== 'vue') {
            return undefined;
        }

        const context = getTagContext(document, position);
        if (!context) {
            return undefined;
        }
        if (!isLikelyComponent(context.tagName)) {
            return undefined;
        }

        await this.index.ensureReady();
        const matches = this.index.findByTag(context.tagName);
        if (matches.length === 0) {
            return undefined;
        }

        // 使用第一个匹配文件（路径最短优先）
        const sorted = [...matches].sort((a, b) => a.uri.fsPath.length - b.uri.fsPath.length);
        const parsed = parseVueComponent(sorted[0].uri.fsPath);
        if (!parsed) {
            return undefined;
        }

        return buildCompletions(parsed, context.mode, sorted[0].uri);
    }
}

type InputMode =
    | 'prop'          // <Comp prop 或 <Comp :prop
    | 'emit'          // <Comp @event
    | 'any';          // <Comp （空格后，prop 和 emit 都给）

interface TagContext {
    tagName: string;
    mode: InputMode;
}

/**
 * 从当前光标位置向前扫描，判断是否处于某个组件标签的属性书写区域，
 * 并确定当前输入的模式（prop / emit / any）。
 *
 * 规则：
 *  - 光标必须在 < tagName ... 之后、> 或 /> 之前
 *  - 当前输入前缀为 @ 时 → emit 模式
 *  - 当前输入前缀为 : 或 v-bind: 时 → prop 模式
 *  - 其他 → any（两者都补全）
 */
function getTagContext(
    document: vscode.TextDocument,
    position: vscode.Position
): TagContext | null {
    // 取从行首到光标的文本，再向前最多扫 500 个字符找到开标签
    const lineText = document.lineAt(position.line).text;
    const charsBefore = lineText.slice(0, position.character);

    // 先看当前行是否包含未关闭的开标签
    // 如果行内没有，则向上找
    const fullBefore = getTextBefore(document, position, 2000);

    // 找到最近的未关闭的 < tagName
    const tagInfo = findOpenTag(fullBefore);
    if (!tagInfo) {
        return null;
    }

    // 判断当前输入模式：看光标紧邻的前缀字符
    // 从标签名结束位置到光标之间的文本
    const attrArea = fullBefore.slice(tagInfo.tagEnd);
    let mode: InputMode = 'any';

    // 找最后一个非引号非空白字符作为前缀判断
    const trimmed = attrArea.trimEnd();
    if (trimmed.endsWith('@')) {
        mode = 'emit';
    } else if (trimmed.endsWith(':') && !trimmed.endsWith('::')) {
        mode = 'prop';
    } else {
        // 判断当前正在写的 token（支持 kebab-case 如 :data-source、@page-event）
        const lastToken = getLastToken(charsBefore);
        if (lastToken.startsWith('@')) {
            mode = 'emit';
        } else if (lastToken.startsWith('v-bind:') || lastToken.startsWith('v-bind')) {
            mode = 'prop';
        } else if (lastToken.startsWith(':') && !lastToken.startsWith('::')) {
            mode = 'prop';
        } else if (/^[a-z][a-z0-9-]*$/.test(lastToken)) {
            // 纯 kebab-case 输入（无前缀）→ any
            mode = 'any';
        }
    }

    return { tagName: tagInfo.tagName, mode };
}

function getTextBefore(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxChars: number
): string {
    const offset = document.offsetAt(position);
    const start = Math.max(0, offset - maxChars);
    const startPos = document.positionAt(start);
    return document.getText(new vscode.Range(startPos, position));
}

function findOpenTag(text: string): { tagName: string; tagEnd: number } | null {
    // 从右往左找最近的 < tagName，且后面没有出现 >
    // 不能用简单正则，因为要跳过字符串中的 < >
    let i = text.length - 1;
    while (i >= 0) {
        const ch = text[i];
        // 遇到 > 说明当前已在一个关闭的标签外面了
        if (ch === '>') {
            return null;
        }
        if (ch === '<') {
            // 看 < 后面跟的是不是合法标签名（非 / 开头）
            const rest = text.slice(i + 1);
            const m = rest.match(/^([A-Za-z][A-Za-z0-9_\-.]*)(\s|$)/);
            if (m) {
                const tagName = m[1];
                const tagEnd = i + 1 + tagName.length;
                return { tagName, tagEnd };
            }
            return null;
        }
        i--;
    }
    return null;
}

function getLastToken(text: string): string {
    // 取行末尾最后一段连续非空字符
    const m = text.match(/(\S+)$/);
    return m ? m[1] : '';
}

function buildCompletions(
    parsed: ParsedVueComponent,
    mode: InputMode,
    fileUri: vscode.Uri
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const fileName = path.basename(fileUri.fsPath);

    if (mode === 'prop' || mode === 'any') {
        for (const prop of parsed.props) {
            // 带绑定前缀的版本 :prop-name
            const bindItem = makePropCompletion(prop, fileName, true);
            // 普通版本 prop-name（字符串/布尔）
            const plainItem = makePropCompletion(prop, fileName, false);
            if (mode === 'any') {
                // any 模式两者都给，用 sortText 让绑定版靠前
                items.push(bindItem, plainItem);
            } else {
                // prop 模式：只给绑定版（前缀已经有 :）
                items.push(plainItem);
            }
        }
    }

    if (mode === 'emit' || mode === 'any') {
        for (const emit of parsed.emits) {
            items.push(makeEmitCompletion(emit, fileName));
        }
    }

    return items;
}

function makePropCompletion(
    prop: ParsedProp,
    fileName: string,
    withColon: boolean
): vscode.CompletionItem {
    const kebab = toKebabCase(prop.name);
    const label = withColon ? `:${kebab}` : kebab;
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Property);

    item.insertText = new vscode.SnippetString(
        withColon ? `:${kebab}="$1"` : `${kebab}="$1"`
    );
    item.filterText = label;
    // 让 camelCase 原名也能命中过滤（用户可能输入 dataS 时也能匹配到 data-source）
    item.filterText = `${label} ${prop.name}`;
    item.sortText = withColon ? `0_${kebab}` : `1_${kebab}`;
    item.detail = `${fileName}  prop`;

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    if (prop.type) {
        md.appendMarkdown(`**类型**：\`${prop.type}\`\n\n`);
    }
    if (prop.defaultValue !== undefined) {
        md.appendMarkdown(`**默认值**：\`${prop.defaultValue}\`\n\n`);
    }
    if (prop.required) {
        md.appendMarkdown(`**必填**\n\n`);
    }
    if (prop.comment) {
        md.appendMarkdown(prop.comment);
    }
    item.documentation = md;

    return item;
}

function makeEmitCompletion(
    emit: ParsedEmit,
    fileName: string
): vscode.CompletionItem {
    const kebab = toKebabCase(emit.name);
    const label = `@${kebab}`;
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Event);
    item.insertText = new vscode.SnippetString(`@${kebab}="$1"`);
    item.filterText = `${label} ${emit.name}`;
    item.sortText = `2_${kebab}`;
    item.detail = `${fileName}  emit`;

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    if (emit.signature) {
        md.appendMarkdown(`**参数**：\`${emit.signature}\`\n\n`);
    }
    if (emit.comment) {
        md.appendMarkdown(emit.comment);
    }
    item.documentation = md;

    return item;
}
