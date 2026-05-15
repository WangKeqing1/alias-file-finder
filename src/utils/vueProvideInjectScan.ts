/**
 * 扫描 Vue SFC 中 provide / inject 的「字符串注入键」位置（不含 Symbol / InjectionKey 跨文件解析）。
 */

export type ProvideInjectKind = 'provide' | 'inject';

export interface ProvideInjectKeySite {
    kind: ProvideInjectKind;
    /** 归一化后的注入键（字符串字面量内容） */
    key: string;
    /** 在整个 .vue 文件文本中的起止偏移（半开区间 [start, end) 对应 key 字面量） */
    start: number;
    end: number;
}

interface ScriptSlice {
    content: string;
    /** content[0] 对应的全局偏移 */
    baseOffset: number;
}

function extractScriptSlices(vueText: string): ScriptSlice[] {
    const out: ScriptSlice[] = [];
    const regex = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(vueText))) {
        const openTag = m[0].substring(0, m[0].indexOf('>') + 1);
        const contentStart = m.index + openTag.length;
        out.push({
            content: m[2],
            baseOffset: contentStart,
        });
    }
    return out;
}

function skipSpaces(src: string, i: number): number {
    while (i < src.length && /\s/.test(src[i])) {
        i++;
    }
    return i;
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
        if (quote === '`' && ch === '$' && src[i + 1] === '{') {
            return -1; // 含插值，不作为静态键
        }
        i++;
    }
    return i;
}

function extractBalanced(src: string, startIdx: number, open: string, close: string): string | null {
    if (src[startIdx] !== open) {
        return null;
    }
    let depth = 0;
    let i = startIdx;
    const len = src.length;
    while (i < len) {
        const ch = src[i];
        if (ch === '"' || ch === '\'' || ch === '`') {
            const next = skipString(src, i);
            if (next === -1) {
                return null;
            }
            i = next;
            continue;
        }
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

/**
 * 从指向 `(` 的位置解析第一个参数若为字符串字面量，则返回其值与在 src 内的起止下标。
 */
function parseFirstStringLiteralArg(
    src: string,
    openParenIdx: number
): { value: string; start: number; end: number } | null {
    if (src[openParenIdx] !== '(') {
        return null;
    }
    let i = skipSpaces(src, openParenIdx + 1);
    const q = src[i];
    if (q !== '"' && q !== '\'' && q !== '`') {
        return null;
    }
    const strStart = i;
    const end = skipString(src, i);
    if (end === -1 || end <= strStart) {
        return null;
    }
    const raw = src.slice(strStart, end);
    const value = unquoteLiteral(raw);
    if (value === null) {
        return null;
    }
    return { value, start: strStart, end };
}

function unquoteLiteral(raw: string): string | null {
    const t = raw.trim();
    if (t.length < 2) {
        return null;
    }
    const q = t[0];
    const endQ = t[t.length - 1];
    if ((q !== '"' && q !== '\'' && q !== '`') || q !== endQ) {
        return null;
    }
    const inner = t.slice(1, -1);
    if (q === '`' && inner.includes('${')) {
        return null;
    }
    if (q === '"') {
        try {
            return JSON.parse(t) as string;
        } catch {
            return null;
        }
    }
    if (q === '\'' || q === '`') {
        return inner.replace(/\\(.)/g, '$1');
    }
    return null;
}

/** inject 调用可为 inject<...>(，定位到 `(` 的下标 */
function findInjectCallParen(src: string, injectWordEnd: number): number {
    let i = skipSpaces(src, injectWordEnd);
    if (src[i] === '<') {
        const gen = extractBalanced(src, i, '<', '>');
        if (!gen) {
            return -1;
        }
        i = skipSpaces(src, i + gen.length);
    }
    return src[i] === '(' ? i : -1;
}

/**
 * 扫描 script 内容中的 provide('key' / inject('key'（含 inject 泛型）。
 */
function scanCompositionCalls(src: string, baseOffset: number, out: ProvideInjectKeySite[]): void {
    // provide('k'
    const provideRe = /\bprovide\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = provideRe.exec(src))) {
        const open = m.index + m[0].length - 1;
        const lit = parseFirstStringLiteralArg(src, open);
        if (lit) {
            out.push({
                kind: 'provide',
                key: lit.value,
                start: baseOffset + lit.start,
                end: baseOffset + lit.end,
            });
        }
    }

    // inject('k' — 允许 inject<...>(
    const injectRe = /\binject\b/g;
    while ((m = injectRe.exec(src))) {
        const afterWord = m.index + m[0].length;
        const open = findInjectCallParen(src, afterWord);
        if (open === -1) {
            continue;
        }
        const lit = parseFirstStringLiteralArg(src, open);
        if (lit) {
            out.push({
                kind: 'inject',
                key: lit.value,
                start: baseOffset + lit.start,
                end: baseOffset + lit.end,
            });
        }
    }
}

function splitTopLevelCommas(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let buf = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === '\'' || ch === '`') {
            const next = skipString(text, i);
            if (next === -1) {
                buf += text.slice(i);
                break;
            }
            buf += text.slice(i, next);
            i = next;
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i);
            const end = nl === -1 ? text.length : nl;
            buf += text.slice(i, end);
            i = end;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const realEnd = end === -1 ? text.length : end + 2;
            buf += text.slice(i, realEnd);
            i = realEnd;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
            buf += ch;
            i++;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            depth--;
            buf += ch;
            i++;
            continue;
        }
        if (ch === ',' && depth === 0) {
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
        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
        } else if (ch === '}' || ch === ']' || ch === ')') {
            depth--;
        } else if (ch === ':' && depth === 0) {
            return i;
        }
        i++;
    }
    return -1;
}

/**
 * Options API：inject: ['a','b'] 或 inject: { x: 'y', z: { from: 'k' } }
 */
function scanOptionsInject(src: string, baseOffset: number, out: ProvideInjectKeySite[]): void {
    const re = /\binject\s*:\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        let i = skipSpaces(src, m.index + m[0].length);
        if (src[i] === '[') {
            const bracketOpen = i;
            const block = extractBalanced(src, i, '[', ']');
            if (!block) {
                continue;
            }
            const inner = block.slice(1, -1);
            const innerBase = bracketOpen + 1;
            const parts = splitTopLevelCommas(inner);
            for (const p of parts) {
                const t = p.trim().replace(/[,;]$/, '');
                const lit = t.match(/^(['"`])([\s\S]*)\1$/);
                if (lit) {
                    const raw = lit[0];
                    const val = unquoteLiteral(raw);
                    if (val !== null) {
                        const idxInInner = inner.indexOf(raw);
                        if (idxInInner !== -1) {
                            const localStart = innerBase + idxInInner;
                            out.push({
                                kind: 'inject',
                                key: val,
                                start: baseOffset + localStart,
                                end: baseOffset + localStart + raw.length,
                            });
                        }
                    }
                }
            }
            continue;
        }
        if (src[i] === '{') {
            const objOpen = i;
            const block = extractBalanced(src, i, '{', '}');
            if (!block) {
                continue;
            }
            const inner = block.slice(1, -1);
            const innerBase = objOpen + 1;
            const props = splitTopLevelCommas(inner);
            for (const prop of props) {
                const colon = findTopLevelColon(prop);
                if (colon === -1) {
                    continue;
                }
                const valPart = prop.slice(colon + 1).trim().replace(/[,;]$/, '');
                // 形态：'remote' 或 { from: 'remote', default: ... }
                const strLit = valPart.match(/^(['"`])([\s\S]*)\1$/);
                if (strLit) {
                    const raw = strLit[0];
                    const val = unquoteLiteral(raw);
                    if (val !== null) {
                        const propStartInInner = inner.indexOf(prop);
                        if (propStartInInner !== -1) {
                            const valOffsetInProp = prop.indexOf(valPart);
                            const rawInVal = valPart.indexOf(raw);
                            if (valOffsetInProp !== -1 && rawInVal !== -1) {
                                const localStart = innerBase + propStartInInner + valOffsetInProp + rawInVal;
                                out.push({
                                    kind: 'inject',
                                    key: val,
                                    start: baseOffset + localStart,
                                    end: baseOffset + localStart + raw.length,
                                });
                            }
                        }
                    }
                    continue;
                }
                if (valPart.startsWith('{')) {
                    const fromHead = valPart.match(/\bfrom\s*:\s*(['"`])/);
                    if (fromHead && fromHead.index !== undefined) {
                        const q = fromHead[1]!;
                        const quoteIdxInVal = fromHead.index + fromHead[0].length - 1;
                        if (valPart[quoteIdxInVal] === q) {
                            const strEnd = skipString(valPart, quoteIdxInVal);
                            if (strEnd !== -1 && strEnd > quoteIdxInVal) {
                                const fullLit = valPart.slice(quoteIdxInVal, strEnd);
                                const val = unquoteLiteral(fullLit);
                                if (val !== null) {
                                    const propStartInInner = inner.indexOf(prop);
                                    if (propStartInInner !== -1) {
                                        const valOffsetInProp = prop.indexOf(valPart);
                                        if (valOffsetInProp !== -1) {
                                            const localStart =
                                                innerBase + propStartInInner + valOffsetInProp + quoteIdxInVal;
                                            out.push({
                                                kind: 'inject',
                                                key: val,
                                                start: baseOffset + localStart,
                                                end: baseOffset + localStart + fullLit.length,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Options API：provide: { foo: 1, 'bar': 2 }
 */
function scanOptionsProvideObject(src: string, baseOffset: number, out: ProvideInjectKeySite[]): void {
    const re = /\bprovide\s*:\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const braceStart = m.index + m[0].length - 1;
        const block = extractBalanced(src, braceStart, '{', '}');
        if (!block) {
            continue;
        }
        const inner = block.slice(1, -1);
        const props = splitTopLevelCommas(inner);
        for (const prop of props) {
            const colon = findTopLevelColon(prop);
            if (colon === -1) {
                continue;
            }
            const keyRaw = prop.slice(0, colon).trim();
            let keyName: string | null = null;
            let keyLiteralLen = 0;
            const ident = keyRaw.match(/^([A-Za-z_$][\w$]*)$/);
            if (ident) {
                keyName = ident[1]!;
                keyLiteralLen = keyName.length;
            } else {
                const lit = keyRaw.match(/^(['"`])([\s\S]*)\1$/);
                if (lit) {
                    const full = lit[0]!;
                    keyName = unquoteLiteral(full);
                    keyLiteralLen = full.length;
                    if (keyName === null) {
                        continue;
                    }
                }
            }
            if (!keyName) {
                continue;
            }
            const propStartInSrc = src.indexOf(prop, braceStart);
            if (propStartInSrc === -1) {
                continue;
            }
            const keyStartInSrc = propStartInSrc + prop.indexOf(keyRaw);
            out.push({
                kind: 'provide',
                key: keyName,
                start: baseOffset + keyStartInSrc,
                end: baseOffset + keyStartInSrc + keyLiteralLen,
            });
        }
    }
}

/**
 * provide() { return { key: ... } } 中 return 对象的一级字符串 / 标识符键。
 */
function scanOptionsProvideFunctionReturn(src: string, baseOffset: number, out: ProvideInjectKeySite[]): void {
    const re = /\bprovide\s*\(\s*\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const bodyStart = m.index + m[0].length - 1;
        const body = extractBalanced(src, bodyStart, '{', '}');
        if (!body) {
            continue;
        }
        const innerBody = body.slice(1, -1);
        const retMatch = innerBody.match(/\breturn\s+/);
        if (!retMatch || retMatch.index === undefined) {
            continue;
        }
        const afterReturn = innerBody.slice(retMatch.index + retMatch[0].length);
        const j = skipSpaces(afterReturn, 0);
        if (afterReturn[j] !== '{') {
            continue;
        }
        const bodyOpenBrace = m.index + m[0].length - 1;
        const absReturnObj =
            bodyOpenBrace + 1 + retMatch.index! + retMatch[0].length + j;
        const objBlock = extractBalanced(src, absReturnObj, '{', '}');
        if (!objBlock) {
            continue;
        }
        const inner = objBlock.slice(1, -1);
        const props = splitTopLevelCommas(inner);
        const objOpenInSrc = absReturnObj;
        for (const prop of props) {
            const colon = findTopLevelColon(prop);
            if (colon === -1) {
                continue;
            }
            const keyRaw = prop.slice(0, colon).trim();
            let keyName: string | null = null;
            let keyLen = 0;
            const ident = keyRaw.match(/^([A-Za-z_$][\w$]*)$/);
            if (ident) {
                keyName = ident[1]!;
                keyLen = keyName.length;
            } else {
                const lit = keyRaw.match(/^(['"`])([\s\S]*)\1$/);
                if (lit) {
                    const full = lit[0]!;
                    keyName = unquoteLiteral(full);
                    keyLen = full.length;
                    if (keyName === null) {
                        continue;
                    }
                }
            }
            if (!keyName) {
                continue;
            }
            const propStart = src.indexOf(prop, objOpenInSrc);
            if (propStart === -1) {
                continue;
            }
            const keyStart = propStart + prop.indexOf(keyRaw);
            out.push({
                kind: 'provide',
                key: keyName,
                start: baseOffset + keyStart,
                end: baseOffset + keyStart + keyLen,
            });
        }
    }
}

/**
 * 返回当前 .vue 文本中所有可索引的 provide/inject 字符串键位置。
 */
export function scanVueProvideInjectKeys(vueText: string): ProvideInjectKeySite[] {
    const out: ProvideInjectKeySite[] = [];
    const slices = extractScriptSlices(vueText);
    for (const s of slices) {
        scanCompositionCalls(s.content, s.baseOffset, out);
        scanOptionsInject(s.content, s.baseOffset, out);
        scanOptionsProvideObject(s.content, s.baseOffset, out);
        scanOptionsProvideFunctionReturn(s.content, s.baseOffset, out);
    }
    return out;
}
