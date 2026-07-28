import * as fs from 'fs';

/**
 * Vue 单文件组件元信息解析。
 *
 * 设计原则：
 * - 不引入 @vue/compiler-sfc 等重依赖，靠手写扫描完成；
 * - 同时兼顾 <script setup>（defineProps/defineEmits/withDefaults）和 Options API（props/emits）；
 * - 保留每个 prop / emit 的前导注释/JSDoc，便于 hover 与补全展示；
 * - 失败时优雅降级，宁可缺一些字段也不抛异常。
 */

export interface ParsedProp {
    name: string;
    type?: string;
    defaultValue?: string;
    required?: boolean;
    comment?: string;
}

export interface ParsedEmit {
    name: string;
    /** 形参签名，如 "(value: string)" */
    signature?: string;
    comment?: string;
}

export interface ParsedVueComponent {
    /** 文件路径 */
    filePath: string;
    /** 组件级 JSDoc 原文（去掉星号边框） */
    componentJsDoc?: string;
    /** 通过 @component 标签声明的组件名（若有） */
    componentName?: string;
    props: ParsedProp[];
    emits: ParsedEmit[];
}

interface CacheEntry {
    mtimeMs: number;
    parsed: ParsedVueComponent | null;
}

const cache = new Map<string, CacheEntry>();

export function clearVueParserCache(filePath?: string): void {
    if (filePath) {
        cache.delete(filePath);
        return;
    }
    cache.clear();
}

export function parseVueComponent(filePath: string): ParsedVueComponent | null {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return null;
    }
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.parsed;
    }
    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return null;
    }
    const parsed = parseVueComponentFromText(text, filePath);
    cache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
    return parsed;
}

export function parseVueComponentFromText(
    text: string,
    filePath: string
): ParsedVueComponent {
    const result: ParsedVueComponent = {
        filePath,
        props: [],
        emits: [],
    };

    const scriptBlocks = extractScriptBlocks(text);
    if (scriptBlocks.length === 0) {
        return result;
    }

    // 优先使用 <script setup> 块
    const scriptSetup = scriptBlocks.find(b => b.isSetup);
    const scriptPlain = scriptBlocks.find(b => !b.isSetup);

    const setupSrc = scriptSetup?.content ?? '';
    const plainSrc = scriptPlain?.content ?? '';

    // 1. 组件级 JSDoc：在 setup 或 plain 顶部找第一个块注释
    const jsdocInfo =
        findTopLevelComponentJsDoc(setupSrc) ||
        findTopLevelComponentJsDoc(plainSrc);
    if (jsdocInfo) {
        result.componentJsDoc = jsdocInfo.content;
        if (jsdocInfo.componentName) {
            result.componentName = jsdocInfo.componentName;
        }
    }

    // 2. setup 写法：defineProps / withDefaults / defineEmits
    if (setupSrc) {
        const propsFromSetup = parseDefineProps(setupSrc);
        if (propsFromSetup.length) {
            result.props.push(...propsFromSetup);
        }
        const emitsFromSetup = parseDefineEmits(setupSrc);
        if (emitsFromSetup.length) {
            result.emits.push(...emitsFromSetup);
        }
    }

    // 3. options 写法：props / emits（多见于 <script>）
    if (plainSrc) {
        if (result.props.length === 0) {
            result.props.push(...parseOptionsProps(plainSrc));
        }
        if (result.emits.length === 0) {
            result.emits.push(...parseOptionsEmits(plainSrc));
        }
        // 若 plain 里也有 defineProps（很少见，但 vue-macros 允许），兜底
        if (result.props.length === 0) {
            result.props.push(...parseDefineProps(plainSrc));
        }
        if (result.emits.length === 0) {
            result.emits.push(...parseDefineEmits(plainSrc));
        }
    }

    return result;
}

// ============================================================================
// script 块抽取
// ============================================================================

interface ScriptBlock {
    content: string;
    isSetup: boolean;
    /** 在原文档中的起始偏移 */
    offset: number;
}

function extractScriptBlocks(text: string): ScriptBlock[] {
    const out: ScriptBlock[] = [];
    const regex = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text))) {
        const attrs = m[1];
        const content = m[2];
        const openTag = m[0].substring(0, m[0].indexOf('>') + 1);
        const contentStart = m.index + openTag.length;
        out.push({
            content,
            isSetup: /\bsetup\b/.test(attrs),
            offset: contentStart,
        });
    }
    return out;
}

// ============================================================================
// 顶层组件级 JSDoc
// ============================================================================

function findTopLevelComponentJsDoc(
    src: string
): { content: string; componentName?: string } | null {
    if (!src) {
        return null;
    }
    // 在 script 开头跳过空白和 import 语句后，找第一个 /** ... */ 块注释
    let i = 0;
    while (i < src.length) {
        // 跳过空白
        while (i < src.length && /\s/.test(src[i])) {
            i++;
        }
        if (i >= src.length) {
            break;
        }
        // 跳过 import 语句
        if (src.startsWith('import', i)) {
            const lineEnd = src.indexOf(';', i);
            const nextNewline = src.indexOf('\n', i);
            const endIdx = lineEnd !== -1 && (nextNewline === -1 || lineEnd < nextNewline)
                ? lineEnd + 1
                : (nextNewline !== -1 ? nextNewline + 1 : src.length);
            i = endIdx;
            continue;
        }
        // 块注释
        if (src[i] === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end === -1) {
                return null;
            }
            const raw = src.substring(i + 2, end);
            const isJsDoc = raw.startsWith('*');
            if (!isJsDoc) {
                // 普通块注释不算组件级 JSDoc，继续找
                i = end + 2;
                continue;
            }
            const cleaned = cleanJsDoc(raw);
            const componentName = extractTagValue(cleaned, 'component');
            return { content: cleaned, componentName };
        }
        // 行注释
        if (src[i] === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i);
            i = nl === -1 ? src.length : nl + 1;
            continue;
        }
        break;
    }
    return null;
}

function cleanJsDoc(raw: string): string {
    // raw 形如 "*\n * @description xxx\n * yyy\n "
    const lines = raw.split(/\r?\n/);
    const cleaned = lines
        .map(line => line.replace(/^\s*\*\s?/, ''))
        .map(line => line.replace(/\s+$/, ''));
    // 去掉首尾空行
    while (cleaned.length && !cleaned[0].trim()) {
        cleaned.shift();
    }
    while (cleaned.length && !cleaned[cleaned.length - 1].trim()) {
        cleaned.pop();
    }
    return cleaned.join('\n');
}

function extractTagValue(jsdoc: string, tag: string): string | undefined {
    const re = new RegExp(`^@${tag}\\s+(.+)$`, 'm');
    const m = jsdoc.match(re);
    return m ? m[1].trim() : undefined;
}

// ============================================================================
// 通用代码工具：括号匹配、按顶层分隔符切割等
// ============================================================================

/**
 * 从 startIdx 起读取一个 open/close 平衡的子串，返回包含括号在内的完整片段。
 */
function extractBalanced(
    src: string,
    startIdx: number,
    open: string,
    close: string
): string | null {
    if (src[startIdx] !== open) {
        return null;
    }
    let depth = 0;
    let i = startIdx;
    const len = src.length;
    while (i < len) {
        const ch = src[i];
        // 跳过字符串
        if (ch === '"' || ch === '\'' || ch === '`') {
            i = skipString(src, i);
            continue;
        }
        // 跳过注释
        if (ch === '/' && src[i + 1] === '/') {
            i = src.indexOf('\n', i);
            if (i === -1) {
                return null;
            }
            i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end === -1) {
                return null;
            }
            i = end + 2;
            continue;
        }
        if (ch === open) {
            depth++;
        } else if (ch === close) {
            depth--;
            if (depth === 0) {
                return src.substring(startIdx, i + 1);
            }
        }
        i++;
    }
    return null;
}

function skipString(src: string, startIdx: number): number {
    const quote = src[startIdx];
    let i = startIdx + 1;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === quote) {
            return i + 1;
        }
        // 模板字符串支持 ${...}
        if (quote === '`' && ch === '$' && src[i + 1] === '{') {
            // 寻找匹配的 }
            let depth = 1;
            i += 2;
            while (i < src.length && depth > 0) {
                const c = src[i];
                if (c === '{') { depth++; }
                else if (c === '}') { depth--; }
                else if (c === '"' || c === '\'' || c === '`') {
                    i = skipString(src, i);
                    continue;
                }
                i++;
            }
            continue;
        }
        i++;
    }
    return i;
}

/**
 * 按顶层 separator（默认 , ;）切割文本，保留每段原始字符（含注释）。
 */
function splitTopLevel(text: string, separators = [',', ';', '\n']): string[] {
    const out: string[] = [];
    let depth = 0;
    let buf = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === '\'' || ch === '`') {
            const next = skipString(text, i);
            buf += text.substring(i, next);
            i = next;
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i);
            const end = nl === -1 ? text.length : nl;
            buf += text.substring(i, end);
            i = end;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const realEnd = end === -1 ? text.length : end + 2;
            buf += text.substring(i, realEnd);
            i = realEnd;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(' || ch === '<') {
            depth++;
            buf += ch;
            i++;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')' || ch === '>') {
            depth--;
            buf += ch;
            i++;
            continue;
        }
        if (depth === 0 && separators.includes(ch)) {
            // 换行作为分隔符时，仅在 buf 当前有效部分非空时拆分（避免空段）
            if (buf.trim() !== '') {
                out.push(buf);
            }
            buf = '';
            i++;
            continue;
        }
        buf += ch;
        i++;
    }
    if (buf.trim() !== '') {
        out.push(buf);
    }
    return out;
}

function findTopLevelColon(text: string): number {
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === '\'' || ch === '`') {
            i = skipString(text, i);
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            i = text.indexOf('\n', i);
            if (i === -1) {
                return -1;
            }
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(' || ch === '<') {
            depth++;
        } else if (ch === '}' || ch === ']' || ch === ')' || ch === '>') {
            depth--;
        } else if (ch === ':' && depth === 0) {
            return i;
        }
        i++;
    }
    return -1;
}

function unquote(text: string): string {
    const t = text.trim();
    if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith('\'') && t.endsWith('\'')) ||
        (t.startsWith('`') && t.endsWith('`'))
    ) {
        return t.slice(1, -1);
    }
    return t;
}

/**
 * 从一段字段文本（可能带多行前导注释）中分离出"前导注释"与"实际内容"。
 *
 * 策略：扫描所有前导注释，但只保留最后一条（即紧邻字段声明的那条）作为字段注释；
 * 区段标题 // === xxx === 之类会被丢弃，只有紧贴字段的 JSDoc 或行注释留下来。
 */
function takeLeadingComment(entry: string): { comment?: string; rest: string } {
    let i = 0;
    let lastComment = '';
    while (i < entry.length) {
        // 跳过空白
        while (i < entry.length && /\s/.test(entry[i])) {
            i++;
        }
        if (i >= entry.length) {
            break;
        }
        if (entry[i] === '/' && entry[i + 1] === '*') {
            const end = entry.indexOf('*/', i + 2);
            if (end === -1) {
                break;
            }
            const raw = entry.substring(i + 2, end);
            lastComment = raw.startsWith('*') ? cleanJsDoc(raw) : cleanBlockComment(raw);
            i = end + 2;
            continue;
        }
        if (entry[i] === '/' && entry[i + 1] === '/') {
            const nl = entry.indexOf('\n', i);
            const end = nl === -1 ? entry.length : nl;
            lastComment = entry.substring(i + 2, end).trim();
            i = end;
            continue;
        }
        break;
    }
    return {
        comment: lastComment.trim() || undefined,
        rest: entry.substring(i),
    };
}

function cleanBlockComment(raw: string): string {
    return raw
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*\*\s?/, '').replace(/^\s+/, ''))
        .map(line => line.replace(/\s+$/, ''))
        .filter((line, idx, arr) => !(idx === 0 && !line) && !(idx === arr.length - 1 && !line))
        .join('\n');
}

// ============================================================================
// defineProps 解析
// ============================================================================

function parseDefineProps(src: string): ParsedProp[] {
    const idx = findCallStart(src, 'defineProps');
    if (idx === -1) {
        return [];
    }
    // 1) 形态 A: defineProps<{...}>() 或  const { ... } = defineProps<{...}>()
    const tsBlock = readGenericBlock(src, idx + 'defineProps'.length);
    if (tsBlock) {
        const props = parseTsTypeLiteralAsProps(tsBlock);
        // 先尝试 withDefaults(...) 的默认值
        applyWithDefaults(src, props);
        // 再尝试解构赋值默认值：const { foo = 'bar' } = defineProps<...>()
        applyDestructuringDefaults(src, idx, props);
        return props;
    }
    // 2) 形态 B: defineProps({...}) 或 defineProps([...])
    const parenStart = skipSpaces(src, idx + 'defineProps'.length);
    if (src[parenStart] !== '(') {
        return [];
    }
    const paren = extractBalanced(src, parenStart, '(', ')');
    if (!paren) {
        return [];
    }
    const inner = paren.slice(1, -1).trim();
    if (inner.startsWith('{')) {
        return parseRuntimePropsObject(inner);
    }
    if (inner.startsWith('[')) {
        return parseRuntimePropsArray(inner);
    }
    return [];
}

/**
 * 解析解构赋值形式的默认值：
 *   const { foo = 'bar', baz = 0, qux } = defineProps<{...}>()
 *
 * 向前扫描 defineProps 调用之前的 `const/let { ... } =`，
 * 再遍历解构项，把 `name = expr` 的 expr 写回到对应 prop 的 defaultValue。
 */
function applyDestructuringDefaults(
    src: string,
    definePropsIdx: number,
    props: ParsedProp[]
): void {
    if (props.length === 0) {
        return;
    }
    // 在 defineProps 之前的 ~800 字符内找 const/let { ... } =
    const lookback = src.slice(Math.max(0, definePropsIdx - 800), definePropsIdx);
    // 找最后一个 `{`（解构开括号）
    const braceStart = lookback.lastIndexOf('{');
    if (braceStart === -1) {
        return;
    }
    // 确认其前面是 const/let/var ... （可以有换行）
    const before = lookback.slice(0, braceStart);
    if (!/\b(?:const|let|var)\s*$/.test(before.trimEnd()) &&
        !/\b(?:const|let|var)\s[\s\S]*$/.test(before)) {
        // 宽松判断：只要 before 中有 const/let/var 且后面没有 = 号（排除对象字面量赋值）
        if (!/\b(?:const|let|var)\b/.test(before)) {
            return;
        }
    }
    // 用原 src 中的实际位置重建平衡读取
    const absoluteBraceStart = Math.max(0, definePropsIdx - 800) + braceStart;
    const destructureBlock = extractBalanced(src, absoluteBraceStart, '{', '}');
    if (!destructureBlock) {
        return;
    }
    // 解析解构块里每一项，提取 name = defaultExpr
    const inner = destructureBlock.slice(1, -1);
    const items = splitTopLevel(inner, [',', '\n']);
    for (const item of items) {
        const { rest } = takeLeadingComment(item);
        const trimmed = rest.trim().replace(/[,;]$/, '').trim();
        if (!trimmed) {
            continue;
        }
        // 支持：  propName = defaultExpr  或  propName（无默认）
        // 也支持：propName: localAlias = defaultExpr（alias 重命名）
        // 先去掉 : alias 部分
        let workText = trimmed;
        const colonIdx = findTopLevelColon(workText);
        if (colonIdx !== -1) {
            // 有 : 说明是重命名解构，冒号后面的才是真正的局部变量和默认值
            workText = workText.slice(colonIdx + 1).trim();
        }
        // 找 =
        const eqIdx = workText.indexOf('=');
        if (eqIdx === -1) {
            continue;
        }
        // 取 prop 原始名（colonIdx === -1 时从 trimmed 取，否则从 trimmed 冒号前取）
        const propNameRaw = colonIdx !== -1
            ? trimmed.slice(0, colonIdx).trim()
            : trimmed.slice(0, eqIdx).trim();
        const propName = propNameRaw.replace(/\s.*$/, ''); // 去掉尾部空白及后续
        const defaultExpr = workText.slice(eqIdx + 1).trim();
        if (!propName || !defaultExpr) {
            continue;
        }
        const prop = props.find(p => p.name === propName);
        if (prop && prop.defaultValue === undefined) {
            prop.defaultValue = simplifyDefault(defaultExpr);
            if (prop.required === undefined || prop.required === true) {
                prop.required = false;
            }
        }
    }
}

/**
 * 查找诸如 `defineProps`/`defineEmits` 的调用起点（不依赖 = 赋值，因为可能在 withDefaults 内）。
 */
function findCallStart(src: string, name: string): number {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        // 必须紧跟 < 或 (
        const after = skipSpaces(src, m.index + name.length);
        const ch = src[after];
        if (ch === '<' || ch === '(') {
            return m.index;
        }
    }
    return -1;
}

function skipSpaces(src: string, i: number): number {
    while (i < src.length && /\s/.test(src[i])) {
        i++;
    }
    return i;
}

function readGenericBlock(src: string, fromIdx: number): string | null {
    const i = skipSpaces(src, fromIdx);
    if (src[i] !== '<') {
        return null;
    }
    // 用 <...> 平衡读取
    const block = extractBalanced(src, i, '<', '>');
    if (!block) {
        return null;
    }
    const inner = block.slice(1, -1).trim();
    // 形态 A: <{ ... }>  内联类型字面量
    if (inner.startsWith('{')) {
        return inner;
    }
    // 形态 B: <TypeName>  具名类型引用 —— 在源码中找 type/interface 定义
    const typeName = inner.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    if (typeName) {
        return resolveNamedType(src, typeName);
    }
    return null;
}

/**
 * 在 src 中查找 `type Name = { ... }` 或 `interface Name { ... }` 并返回花括号块。
 * 同时保留块内的前导行注释，供后续解析注释使用。
 */
function resolveNamedType(src: string, name: string): string | null {
    // type Name = { ... }
    const typeRe = new RegExp(`\\btype\\s+${name}\\s*=\\s*`, 'g');
    let m: RegExpExecArray | null;
    while ((m = typeRe.exec(src))) {
        const start = skipSpaces(src, m.index + m[0].length);
        if (src[start] === '{') {
            const block = extractBalanced(src, start, '{', '}');
            if (block) {
                return block;
            }
        }
    }
    // interface Name { ... }
    const ifaceRe = new RegExp(`\\binterface\\s+${name}\\b[^{]*`, 'g');
    while ((m = ifaceRe.exec(src))) {
        const start = src.indexOf('{', m.index + m[0].length - 1);
        if (start === -1) {
            continue;
        }
        const block = extractBalanced(src, start, '{', '}');
        if (block) {
            return block;
        }
    }
    return null;
}

function parseTsTypeLiteralAsProps(block: string): ParsedProp[] {
    // block 形如 "{ foo: string; bar?: number; /** xxx */ baz: () => void }"
    const trimmed = block.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return [];
    }
    const inner = trimmed.slice(1, -1);
    // 只按 ; 分割，不按 \n 分割，避免多行注释与属性被拆成两条 entry
    const entries = splitTopLevel(inner, [';']);
    const out: ParsedProp[] = [];
    for (const entry of entries) {
        const { comment, rest } = takeLeadingComment(entry);
        const trimmedRest = rest.trim();
        if (!trimmedRest) {
            continue;
        }
        // 形如 readonly foo?: string
        const m = trimmedRest.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*:\s*([\s\S]+)$/);
        if (!m) {
            continue;
        }
        const name = m[1];
        const optional = m[2] === '?';
        const type = m[3].trim().replace(/[;,]\s*$/, '').trim();
        out.push({
            name,
            type,
            required: !optional,
            comment,
        });
    }
    return out;
}

function parseRuntimePropsObject(inner: string): ParsedProp[] {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return [];
    }
    const body = trimmed.slice(1, -1);
    const entries = splitTopLevel(body, [',', '\n']);
    const out: ParsedProp[] = [];
    for (const entry of entries) {
        const { comment, rest } = takeLeadingComment(entry);
        const colonIdx = findTopLevelColon(rest);
        if (colonIdx === -1) {
            continue;
        }
        const name = unquote(rest.slice(0, colonIdx).trim());
        if (!name || !/^[\w$]+$/.test(name)) {
            continue;
        }
        const valueExpr = rest.slice(colonIdx + 1).trim().replace(/[,;]$/, '').trim();
        const prop: ParsedProp = { name, comment };
        // 若 value 是对象：{ type, default, required }
        if (valueExpr.startsWith('{')) {
            const innerObj = valueExpr.slice(1, -1);
            const fields = splitTopLevel(innerObj, [',', '\n']);
            for (const f of fields) {
                const { rest: fRest } = takeLeadingComment(f);
                const fColon = findTopLevelColon(fRest);
                if (fColon === -1) {
                    continue;
                }
                const fName = unquote(fRest.slice(0, fColon).trim());
                const fVal = fRest.slice(fColon + 1).trim().replace(/[,;]$/, '').trim();
                if (fName === 'type') {
                    prop.type = stringifyPropType(fVal);
                } else if (fName === 'default') {
                    prop.defaultValue = simplifyDefault(fVal);
                } else if (fName === 'required') {
                    prop.required = fVal === 'true';
                }
            }
        } else {
            // 直接是构造函数：String / [String, Number]
            prop.type = stringifyPropType(valueExpr);
        }
        out.push(prop);
    }
    return out;
}

function parseRuntimePropsArray(inner: string): ParsedProp[] {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
        return [];
    }
    const body = trimmed.slice(1, -1);
    const entries = splitTopLevel(body, [',', '\n']);
    const out: ParsedProp[] = [];
    for (const entry of entries) {
        const { comment, rest } = takeLeadingComment(entry);
        const name = unquote(rest.trim());
        if (!name) {
            continue;
        }
        out.push({ name, comment });
    }
    return out;
}

function stringifyPropType(expr: string): string {
    const t = expr.trim().replace(/[,;]$/, '').trim();
    if (t.startsWith('[') && t.endsWith(']')) {
        const arr = splitTopLevel(t.slice(1, -1), [',']);
        return arr.map(s => s.trim()).filter(Boolean).join(' | ');
    }
    return t;
}

function simplifyDefault(expr: string): string {
    const t = expr.trim();
    // 形如 `() => [...]` 或 `() => ({})`：保留为简短表达
    if (/^\(\s*\)\s*=>/.test(t)) {
        return t.replace(/\s+/g, ' ');
    }
    // 单行简短表达直接返回；多行的话压缩空白
    if (t.length <= 80) {
        return t;
    }
    return t.replace(/\s+/g, ' ').slice(0, 77) + '...';
}

/**
 * 处理 withDefaults(defineProps<{...}>(), { foo: 'bar' }) 中第二个参数对默认值的设置。
 */
function applyWithDefaults(src: string, props: ParsedProp[]): void {
    if (props.length === 0) {
        return;
    }
    const re = /\bwithDefaults\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const parenStart = m.index + m[0].length - 1;
        const paren = extractBalanced(src, parenStart, '(', ')');
        if (!paren) {
            continue;
        }
        const inner = paren.slice(1, -1);
        // 取顶层逗号拆出两个参数
        const args = splitTopLevel(inner, [',']);
        if (args.length < 2) {
            continue;
        }
        const defaultsExpr = args[1].trim();
        if (!defaultsExpr.startsWith('{')) {
            continue;
        }
        const innerObj = defaultsExpr.slice(1, -1);
        const fields = splitTopLevel(innerObj, [',', '\n']);
        for (const f of fields) {
            const { rest } = takeLeadingComment(f);
            const colonIdx = findTopLevelColon(rest);
            if (colonIdx === -1) {
                continue;
            }
            const name = unquote(rest.slice(0, colonIdx).trim());
            const value = rest.slice(colonIdx + 1).trim().replace(/[,;]$/, '').trim();
            const prop = props.find(p => p.name === name);
            if (prop) {
                prop.defaultValue = simplifyDefault(value);
                if (prop.required === undefined) {
                    prop.required = false;
                }
            }
        }
    }
}

// ============================================================================
// defineEmits 解析
// ============================================================================

function parseDefineEmits(src: string): ParsedEmit[] {
    const idx = findCallStart(src, 'defineEmits');
    if (idx === -1) {
        return [];
    }
    // 1) defineEmits<{...}>()
    const tsBlock = readGenericBlock(src, idx + 'defineEmits'.length);
    if (tsBlock) {
        return parseTsTypeLiteralAsEmits(tsBlock);
    }
    // 2) defineEmits([...]) / defineEmits({...})
    const parenStart = skipSpaces(src, idx + 'defineEmits'.length);
    if (src[parenStart] !== '(') {
        return [];
    }
    const paren = extractBalanced(src, parenStart, '(', ')');
    if (!paren) {
        return [];
    }
    const inner = paren.slice(1, -1).trim();
    if (inner.startsWith('[')) {
        return parseRuntimeEmitsArray(inner);
    }
    if (inner.startsWith('{')) {
        return parseRuntimeEmitsObject(inner);
    }
    return [];
}

function parseTsTypeLiteralAsEmits(block: string): ParsedEmit[] {
    const trimmed = block.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return [];
    }
    const inner = trimmed.slice(1, -1);
    // 只按 ; 分割，保证注释与调用签名在同一 entry 内
    const entries = splitTopLevel(inner, [';']);
    const out: ParsedEmit[] = [];
    for (const entry of entries) {
        const { comment, rest } = takeLeadingComment(entry);
        const text = rest.trim().replace(/[;,]\s*$/, '').trim();
        if (!text) {
            continue;
        }
        // 形态 A: (e: 'change', val: string): void
        const callA = text.match(/^\(\s*[a-zA-Z_$][\w$]*\s*:\s*['"`]([^'"`]+)['"`]\s*(,([\s\S]*))?\)\s*:\s*[\s\S]+$/);
        if (callA) {
            const name = callA[1];
            const restArgs = callA[3]?.trim();
            const signature = restArgs ? `(${restArgs})` : '()';
            out.push({ name, signature, comment });
            continue;
        }
        // 形态 B: 'change': [val: string] 或 change: [val: string]
        const callB = text.match(/^['"`]?([\w$-]+)['"`]?\s*:\s*\[([\s\S]*)\]\s*$/);
        if (callB) {
            const name = callB[1];
            const args = callB[2].trim();
            out.push({
                name,
                signature: args ? `(${args})` : '()',
                comment,
            });
            continue;
        }
        // 形态 C: 'change': (val: string) => void
        const callC = text.match(/^['"`]?([\w$-]+)['"`]?\s*:\s*\(([\s\S]*?)\)\s*=>/);
        if (callC) {
            const name = callC[1];
            const args = callC[2].trim();
            out.push({
                name,
                signature: args ? `(${args})` : '()',
                comment,
            });
            continue;
        }
    }
    return out;
}

function parseRuntimeEmitsArray(inner: string): ParsedEmit[] {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
        return [];
    }
    const body = trimmed.slice(1, -1);
    const entries = splitTopLevel(body, [',', '\n']);
    const out: ParsedEmit[] = [];
    for (const entry of entries) {
        const { comment, rest } = takeLeadingComment(entry);
        const name = unquote(rest.trim());
        if (!name) {
            continue;
        }
        out.push({ name, comment });
    }
    return out;
}

function parseRuntimeEmitsObject(inner: string): ParsedEmit[] {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return [];
    }
    const body = trimmed.slice(1, -1);
    const entries = splitTopLevel(body, [',', '\n']);
    const out: ParsedEmit[] = [];
    for (const entry of entries) {
        const { comment, rest } = takeLeadingComment(entry);
        const colonIdx = findTopLevelColon(rest);
        if (colonIdx === -1) {
            continue;
        }
        const name = unquote(rest.slice(0, colonIdx).trim());
        if (!name) {
            continue;
        }
        out.push({ name, comment });
    }
    return out;
}

// ============================================================================
// Options API 解析（props / emits）
// ============================================================================

function parseOptionsProps(src: string): ParsedProp[] {
    const objStart = findOptionsKeyStart(src, 'props');
    if (objStart === -1) {
        return [];
    }
    const ch = src[objStart];
    if (ch === '{') {
        const block = extractBalanced(src, objStart, '{', '}');
        if (!block) {
            return [];
        }
        return parseRuntimePropsObject(block);
    }
    if (ch === '[') {
        const block = extractBalanced(src, objStart, '[', ']');
        if (!block) {
            return [];
        }
        return parseRuntimePropsArray(block);
    }
    return [];
}

function parseOptionsEmits(src: string): ParsedEmit[] {
    const objStart = findOptionsKeyStart(src, 'emits');
    if (objStart === -1) {
        return [];
    }
    const ch = src[objStart];
    if (ch === '[') {
        const block = extractBalanced(src, objStart, '[', ']');
        if (!block) {
            return [];
        }
        return parseRuntimeEmitsArray(block);
    }
    if (ch === '{') {
        const block = extractBalanced(src, objStart, '{', '}');
        if (!block) {
            return [];
        }
        return parseRuntimeEmitsObject(block);
    }
    return [];
}

/**
 * 在 src 中找到 Options API 字段（如 props/emits）的 value 起点（指向 { 或 [）。
 */
function findOptionsKeyStart(src: string, key: string): number {
    const re = new RegExp(`(^|[\\{,\\s])${key}\\s*:\\s*`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const end = m.index + m[0].length;
        const ch = src[end];
        if (ch === '{' || ch === '[') {
            return end;
        }
    }
    return -1;
}

// ============================================================================
// 公用名称转换工具
// ============================================================================

/**
 * camelCase / PascalCase → kebab-case
 * e.g. dataSource → data-source, pageEvent → page-event
 */
export function toKebabCase(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}
