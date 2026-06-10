import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { affLog } from '../affLog';
import {
    getFrontIntelligenceSettings,
    getLegacyAliasSettings,
    type NormalizedAliasSettings,
} from './settingsService';

export interface AliasMap {
    [alias: string]: string[];
}

interface CacheEntry {
    aliases: AliasMap;
    expireAt: number;
}

const CACHE_TTL = 5 * 1000;

const cache = new Map<string, CacheEntry>();

export function clearAliasCache(): void {
    cache.clear();
}

export function getAliases(workspaceFolder: vscode.WorkspaceFolder): AliasMap {
    const cwd = workspaceFolder.uri.fsPath;
    const now = Date.now();
    const cached = cache.get(cwd);
    if (cached && cached.expireAt > now) {
        return cached.aliases;
    }

    const settings = getFrontIntelligenceSettings(workspaceFolder.uri);
    if (!settings.enabled || !settings.alias.enabled) {
        const aliases: AliasMap = {};
        cache.set(cwd, { aliases, expireAt: now + CACHE_TTL });
        return aliases;
    }

    const aliases: AliasMap = {};
    const customAliases = resolveConfiguredAliases(settings.alias.custom, cwd);
    const legacyAliases = resolveConfiguredAliases(getLegacyAliasSettings(workspaceFolder.uri), cwd);
    const autoAliases = settings.alias.autoDetect
        ? readAutoAliases(cwd, settings.alias.sources)
        : {};
    const fallbackAliases = resolveExistingFallbackAliases(settings.alias.fallbacks, cwd);

    if (settings.alias.priority === 'auto-first') {
        mergeAliases(aliases, autoAliases);
        mergeAliases(aliases, customAliases);
        mergeAliases(aliases, legacyAliases);
    } else {
        mergeAliases(aliases, customAliases);
        mergeAliases(aliases, legacyAliases);
        mergeAliases(aliases, autoAliases);
    }
    mergeAliases(aliases, fallbackAliases);

    cache.set(cwd, { aliases, expireAt: now + CACHE_TTL });
    affLog('aliases:reload', {
        cwd,
        keys: Object.keys(aliases),
        preview: Object.fromEntries(
            Object.entries(aliases).map(([k, v]) => [k, v.slice(0, 3)])
        ),
    });
    return aliases;
}

function mergeAliases(target: AliasMap, src: AliasMap): void {
    for (const key of Object.keys(src)) {
        if (!target[key]) {
            target[key] = src[key];
        } else {
            for (const v of src[key]) {
                if (!target[key].includes(v)) {
                    target[key].push(v);
                }
            }
        }
    }
}

function resolveConfiguredAliases(raw: NormalizedAliasSettings, cwd: string): AliasMap {
    const out: AliasMap = {};
    for (const [key, values] of Object.entries(raw)) {
        out[key] = values.map(p => resolveToAbs(p, cwd));
    }
    return out;
}

function resolveExistingFallbackAliases(raw: NormalizedAliasSettings, cwd: string): AliasMap {
    const out: AliasMap = {};
    for (const [key, values] of Object.entries(raw)) {
        const resolved = values
            .map(p => resolveToAbs(p, cwd))
            .filter(p => fs.existsSync(p));
        if (resolved.length > 0) {
            out[key] = resolved;
        }
    }
    return out;
}

function readAutoAliases(cwd: string, sources: string[]): AliasMap {
    const out: AliasMap = {};
    if (isAliasSourceEnabled(sources, 'tsconfig.json')) {
        mergeAliases(out, readFromTsConfig(cwd, ['tsconfig.json']));
    }
    if (isAliasSourceEnabled(sources, 'jsconfig.json')) {
        mergeAliases(out, readFromTsConfig(cwd, ['jsconfig.json']));
    }
    if (isAliasSourceEnabled(sources, 'vite.config.*')) {
        mergeAliases(out, readFromViteConfig(cwd));
    }
    if (isAliasSourceEnabled(sources, 'webpack.config.*')) {
        mergeAliases(out, readFromWebpackConfig(cwd));
    }
    if (isAliasSourceEnabled(sources, 'nuxt.config.*')) {
        mergeAliases(out, readFromNuxtConfig(cwd));
    }
    if (isAliasSourceEnabled(sources, 'vue.config.*')) {
        mergeAliases(out, readFromVueCliConfig(cwd));
    }
    if (isAliasSourceEnabled(sources, 'config.*')) {
        mergeAliases(out, readFromGenericConfig(cwd));
    }
    return out;
}

function isAliasSourceEnabled(sources: string[], source: string): boolean {
    return sources.includes(source);
}

function resolveToAbs(p: string, cwd: string): string {
    if (path.isAbsolute(p)) {
        return p;
    }
    return path.resolve(cwd, p);
}

function safeReadFile(p: string): string | null {
    try {
        if (!fs.existsSync(p)) {
            return null;
        }
        return fs.readFileSync(p, 'utf-8');
    } catch {
        return null;
    }
}

function stripJsonComments(text: string): string {
    // 简单移除 // 行注释和 /* */ 块注释，保留字符串内的内容
    let result = '';
    let i = 0;
    let inString = false;
    let stringChar = '';
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (inString) {
            if (ch === '\\' && i + 1 < text.length) {
                result += ch + text[i + 1];
                i += 2;
                continue;
            }
            if (ch === stringChar) {
                inString = false;
            }
            result += ch;
            i++;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            inString = true;
            stringChar = ch;
            result += ch;
            i++;
            continue;
        }
        if (ch === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                i++;
            }
            i += 2;
            continue;
        }
        result += ch;
        i++;
    }
    // 顺手去掉尾逗号
    result = result.replace(/,\s*([}\]])/g, '$1');
    return result;
}

function readFromTsConfig(cwd: string, candidates = ['tsconfig.json', 'jsconfig.json']): AliasMap {
    const out: AliasMap = {};
    for (const name of candidates) {
        const full = path.join(cwd, name);
        const raw = safeReadFile(full);
        if (!raw) {
            continue;
        }
        try {
            const json = JSON.parse(stripJsonComments(raw));
            const co = json && json.compilerOptions;
            if (!co) {
                continue;
            }
            const baseUrl: string = co.baseUrl ? path.resolve(cwd, co.baseUrl) : cwd;
            const paths: Record<string, string[]> = co.paths || {};
            for (const key of Object.keys(paths)) {
                const target = paths[key];
                if (!Array.isArray(target)) {
                    continue;
                }
                // 处理 "@/*": ["src/*"] 形式
                const cleanKey = key.replace(/\/?\*$/, '');
                const resolved = target.map(t => {
                    const noStar = t.replace(/\/?\*$/, '');
                    return path.resolve(baseUrl, noStar);
                });
                if (!out[cleanKey]) {
                    out[cleanKey] = resolved;
                } else {
                    for (const r of resolved) {
                        if (!out[cleanKey].includes(r)) {
                            out[cleanKey].push(r);
                        }
                    }
                }
            }
        } catch {
            // ignore
        }
    }
    return out;
}

function readFromViteConfig(cwd: string): AliasMap {
    const out: AliasMap = {};
    const candidates = [
        'vite.config.ts',
        'vite.config.js',
        'vite.config.mts',
        'vite.config.mjs',
        'vite.config.cts',
        'vite.config.cjs',
    ];
    for (const name of candidates) {
        const full = path.join(cwd, name);
        const raw = safeReadFile(full);
        if (!raw) {
            continue;
        }
        Object.assign(out, parseAliasFromJsSource(raw, cwd));
    }
    return out;
}

function readFromWebpackConfig(cwd: string): AliasMap {
    const out: AliasMap = {};
    const candidates = [
        'webpack.config.js',
        'webpack.config.ts',
        'webpack.common.js',
        'webpack.dev.js',
        'webpack.prod.js',
    ];
    for (const name of candidates) {
        const full = path.join(cwd, name);
        const raw = safeReadFile(full);
        if (!raw) {
            continue;
        }
        Object.assign(out, parseAliasFromJsSource(raw, cwd));
    }
    return out;
}

function readFromVueCliConfig(cwd: string): AliasMap {
    const out: AliasMap = {};
    const full = path.join(cwd, 'vue.config.js');
    const raw = safeReadFile(full);
    if (!raw) {
        return out;
    }
    Object.assign(out, parseAliasFromJsSource(raw, cwd));
    return out;
}

function readFromNuxtConfig(cwd: string): AliasMap {
    const out: AliasMap = {};
    const candidates = ['nuxt.config.ts', 'nuxt.config.js'];
    for (const name of candidates) {
        const full = path.join(cwd, name);
        const raw = safeReadFile(full);
        if (!raw) {
            continue;
        }
        Object.assign(out, parseAliasFromJsSource(raw, cwd));
    }
    return out;
}

function readFromGenericConfig(cwd: string): AliasMap {
    const out: AliasMap = {};
    const candidates = [
        'config.ts',
        'config.js',
        'config.mts',
        'config.mjs',
        'config.cts',
        'config.cjs',
    ];
    for (const name of candidates) {
        const full = path.join(cwd, name);
        const raw = safeReadFile(full);
        if (!raw) {
            continue;
        }
        mergeAliases(out, parseAliasFromJsSource(raw, cwd));
    }
    return out;
}

/**
 * 用静态分析的方式从 JS/TS 配置文件源码中提取 alias 配置。
 * 支持的形式：
 *   alias: { '@': path.resolve(__dirname, 'src'), '~': resolve('src') }
 *   alias: [ { find: '@', replacement: path.resolve(__dirname, 'src') } ]
 *   resolve: { alias: { ... } }
 */
function parseAliasFromJsSource(src: string, cwd: string): AliasMap {
    const out: AliasMap = {};

    // 对象字面量形式：alias: { ... }
    const objBlocks = extractAliasObjectBlocks(src);
    for (const block of objBlocks) {
        parseObjectAliasBlock(block, cwd, out);
    }

    // 数组形式：alias: [ { find, replacement } ]
    const arrBlocks = extractAliasArrayBlocks(src);
    for (const block of arrBlocks) {
        parseArrayAliasBlock(block, cwd, out);
    }

    return out;
}

function extractAliasObjectBlocks(src: string): string[] {
    const blocks: string[] = [];
    const regex = /alias\s*:\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(src))) {
        const startIdx = m.index + m[0].length - 1; // 指向 {
        const block = extractBalanced(src, startIdx, '{', '}');
        if (block) {
            blocks.push(block);
        }
    }
    return blocks;
}

function extractAliasArrayBlocks(src: string): string[] {
    const blocks: string[] = [];
    const regex = /alias\s*:\s*\[/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(src))) {
        const startIdx = m.index + m[0].length - 1; // 指向 [
        const block = extractBalanced(src, startIdx, '[', ']');
        if (block) {
            blocks.push(block);
        }
    }
    return blocks;
}

function extractBalanced(src: string, startIdx: number, open: string, close: string): string | null {
    if (src[startIdx] !== open) {
        return null;
    }
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let inTemplate = false;
    for (let i = startIdx; i < src.length; i++) {
        const ch = src[i];
        const prev = src[i - 1];
        if (inString) {
            if (prev !== '\\' && ch === stringChar) {
                inString = false;
            }
            continue;
        }
        if (inTemplate) {
            if (prev !== '\\' && ch === '`') {
                inTemplate = false;
            }
            continue;
        }
        if (ch === '"' || ch === '\'') {
            inString = true;
            stringChar = ch;
            continue;
        }
        if (ch === '`') {
            inTemplate = true;
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
    }
    return null;
}

function parseObjectAliasBlock(block: string, cwd: string, out: AliasMap): void {
    // 提取每条 key: value 项，仅保留最外层
    const entries = splitTopLevelEntries(block.slice(1, -1));
    for (const entry of entries) {
        const colonIdx = findTopLevelColon(entry);
        if (colonIdx === -1) {
            continue;
        }
        const rawKey = entry.slice(0, colonIdx).trim();
        const rawVal = entry.slice(colonIdx + 1).trim();
        const key = unquote(rawKey);
        if (!key) {
            continue;
        }
        const resolved = resolveValueExpr(rawVal, cwd);
        if (resolved) {
            if (!out[key]) {
                out[key] = [resolved];
            } else if (!out[key].includes(resolved)) {
                out[key].push(resolved);
            }
        }
    }
}

function parseArrayAliasBlock(block: string, cwd: string, out: AliasMap): void {
    const inner = block.slice(1, -1);
    const items = splitTopLevelEntries(inner);
    for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed.startsWith('{')) {
            continue;
        }
        const objInner = trimmed.slice(1, trimmed.length - 1);
        const fields = splitTopLevelEntries(objInner);
        let findVal: string | null = null;
        let replacementVal: string | null = null;
        for (const field of fields) {
            const colonIdx = findTopLevelColon(field);
            if (colonIdx === -1) {
                continue;
            }
            const fKey = unquote(field.slice(0, colonIdx).trim());
            const fVal = field.slice(colonIdx + 1).trim();
            if (fKey === 'find') {
                findVal = extractStringLiteral(fVal);
            } else if (fKey === 'replacement') {
                replacementVal = resolveValueExpr(fVal, cwd);
            }
        }
        if (findVal && replacementVal) {
            const key = findVal;
            if (!out[key]) {
                out[key] = [replacementVal];
            } else if (!out[key].includes(replacementVal)) {
                out[key].push(replacementVal);
            }
        }
    }
}

function splitTopLevelEntries(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let buffer = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const prev = text[i - 1];
        if (inString) {
            buffer += ch;
            if (prev !== '\\' && ch === stringChar) {
                inString = false;
            }
            continue;
        }
        if (ch === '"' || ch === '\'' || ch === '`') {
            inString = true;
            stringChar = ch;
            buffer += ch;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
            buffer += ch;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            depth--;
            buffer += ch;
            continue;
        }
        if (ch === ',' && depth === 0) {
            if (buffer.trim()) {
                out.push(buffer);
            }
            buffer = '';
            continue;
        }
        buffer += ch;
    }
    if (buffer.trim()) {
        out.push(buffer);
    }
    return out;
}

function findTopLevelColon(text: string): number {
    let depth = 0;
    let inString = false;
    let stringChar = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const prev = text[i - 1];
        if (inString) {
            if (prev !== '\\' && ch === stringChar) {
                inString = false;
            }
            continue;
        }
        if (ch === '"' || ch === '\'' || ch === '`') {
            inString = true;
            stringChar = ch;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            depth--;
            continue;
        }
        if (ch === ':' && depth === 0) {
            return i;
        }
    }
    return -1;
}

function unquote(text: string): string {
    const t = text.trim();
    if ((t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith('\'') && t.endsWith('\'')) ||
        (t.startsWith('`') && t.endsWith('`'))) {
        return t.slice(1, -1);
    }
    // 处理 [Symbol] 或其他动态 key 时跳过
    if (t.startsWith('[')) {
        return '';
    }
    return t;
}

function extractStringLiteral(expr: string): string | null {
    const t = expr.trim().replace(/[,;]$/, '').trim();
    if ((t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith('\'') && t.endsWith('\'')) ||
        (t.startsWith('`') && t.endsWith('`'))) {
        return t.slice(1, -1);
    }
    return null;
}

/**
 * 解析 value 表达式为绝对路径：
 *  - 'src' / "./src" / `src`     => path.resolve(cwd, ...)
 *  - path.resolve(__dirname, 'src') / resolve(__dirname, 'src') => 拼接
 *  - path.join(__dirname, 'src')
 *  - fileURLToPath(new URL('./src', import.meta.url))
 */
function resolveValueExpr(expr: string, cwd: string): string | null {
    const t = expr.trim().replace(/[,;]$/, '').trim();

    // 字符串字面量
    const literal = extractStringLiteral(t);
    if (literal !== null) {
        return path.resolve(cwd, literal);
    }

    // path.resolve / path.join / resolve / join
    const resolveMatch = t.match(/^(?:path\.)?(?:resolve|join)\s*\(\s*([\s\S]*)\s*\)\s*$/);
    if (resolveMatch) {
        const args = splitTopLevelEntries(resolveMatch[1]);
        const parts: string[] = [];
        for (const a of args) {
            const ta = a.trim();
            if (ta === '__dirname' || ta === '__filename' || ta === 'process.cwd()') {
                parts.push(cwd);
                continue;
            }
            const lit = extractStringLiteral(ta);
            if (lit !== null) {
                parts.push(lit);
                continue;
            }
            // 不支持的复杂表达式
            return null;
        }
        if (parts.length === 0) {
            return null;
        }
        return path.resolve(cwd, ...parts);
    }

    // fileURLToPath(new URL('./src', import.meta.url))
    const urlMatch = t.match(/fileURLToPath\s*\(\s*new\s+URL\s*\(\s*(['"`])([^'"`]+)\1/);
    if (urlMatch) {
        return path.resolve(cwd, urlMatch[2]);
    }

    return null;
}
