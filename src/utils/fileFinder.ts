import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AliasMap, getAliases } from '../config/aliasResolver';
import { affLog } from '../affLog';

export interface ResolveContext {
    /** 引用所在文件的绝对路径 */
    fromFile: string;
    /** 引用所在工作区 */
    workspaceFolder: vscode.WorkspaceFolder;
    /**
     * 文件扩展名候选，按顺序尝试。
     * 比如 css 上下文一般给 ['.scss', '.sass', '.less', '.css']。
     */
    extensions: string[];
    /**
     * 是否尝试 css partial（以 _ 开头）。
     */
    tryPartial?: boolean;
    /**
     * 是否尝试 index 文件。
     */
    tryIndex?: boolean;
}

/**
 * 把书写形式的引用路径解析为绝对路径。
 * - 处理 alias 前缀（最长前缀匹配）
 * - 处理 ~package（webpack-style）裸引用 -> node_modules
 * - 处理相对路径
 */
export function resolveReferencePath(spec: string, ctx: ResolveContext): string | null {
    const cleaned = spec.trim();
    if (!cleaned) {
        return null;
    }

    if (isHttpUrl(cleaned)) {
        return null;
    }

    const candidates = expandToCandidatePaths(cleaned, ctx);
    for (const candidate of candidates) {
        const hit = findExistingFile(candidate, ctx);
        if (hit) {
            affLog('resolve:hit', { spec: cleaned, hit, triedCount: candidates.length });
            return hit;
        }
    }
    affLog('resolve:miss', {
        spec: cleaned,
        workspaceRoot: ctx.workspaceFolder.uri.fsPath,
        fromFile: ctx.fromFile,
        candidates: candidates.slice(0, 12),
        candidateTotal: candidates.length,
    });
    return null;
}

export function isHttpUrl(spec: string): boolean {
    return /^(https?:|\/\/)/i.test(spec);
}

function normalizeFsPath(p: string): string {
    const n = path.normalize(path.resolve(p));
    if (process.platform === 'win32' && n.length >= 2 && n[1] === ':') {
        return n[0].toUpperCase() + n.slice(1);
    }
    return n;
}

/**
 * 将解析得到的绝对磁盘路径转为用于 DocumentLink / Definition 的 Uri。
 * 若路径落在当前工作区根目录下，使用 `Uri.joinPath(workspaceFolder.uri, …)` 与编辑器内工作区 URI 对齐，
 * 避免在 Cursor + Windows 下仅用 `Uri.file` 时出现能解析但无法打开编辑器的情况。
 */
export function fsPathToOpenUri(absoluteFsPath: string, workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
    const target = normalizeFsPath(absoluteFsPath);
    const root = normalizeFsPath(workspaceFolder.uri.fsPath);

    const isWin = process.platform === 'win32';
    const t = isWin ? target.toLowerCase() : target;
    const r = isWin ? root.toLowerCase() : root;

    const inside = t === r || t.startsWith(r + path.sep);
    if (inside && workspaceFolder.uri.scheme === 'file') {
        const rel = path.relative(root, target);
        if (!rel || rel === '.' || rel.startsWith('..' + path.sep) || rel === '..') {
            return vscode.Uri.file(target);
        }
        const parts = rel.split(/[/\\]+/).filter(Boolean);
        if (parts.length === 0) {
            return workspaceFolder.uri;
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, ...parts);
    }

    return vscode.Uri.file(target);
}

/**
 * 把一个引用 spec 展开为多个候选的绝对路径"前缀"。
 * 后续会再为每个前缀尝试不同扩展名 / partial / index 等。
 */
function expandToCandidatePaths(spec: string, ctx: ResolveContext): string[] {
    const out: string[] = [];

    // 去掉前缀 ~ ：webpack/vue-cli 用 ~ 表示从 node_modules 解析或继续走 alias
    let working = spec;
    let strippedTilde = false;
    if (working.startsWith('~') && !working.startsWith('~/')) {
        // ~xxx 形式
        // 注意：~@/xxx 这种是 alias，先不剥
        if (!working.startsWith('~@')) {
            strippedTilde = true;
            working = working.substring(1);
        }
    } else if (working.startsWith('~/')) {
        // ~/ 通常是某些项目的 home alias，不动它
    }

    // 1. 相对路径
    if (working.startsWith('.') || working.startsWith('/')) {
        if (working.startsWith('/')) {
            // 绝对路径（POSIX 风格）
            out.push(working);
        } else {
            out.push(path.resolve(path.dirname(ctx.fromFile), working));
        }
        return out;
    }

    // 2. alias 解析
    const aliases = getAliases(ctx.workspaceFolder);
    const aliasResult = applyAlias(working, aliases);
    if (aliasResult.length > 0) {
        out.push(...aliasResult);
    }

    // 3. node_modules（用于 ~bootstrap/... 或 @scope/pkg/...）
    const nmRoot = path.join(ctx.workspaceFolder.uri.fsPath, 'node_modules');
    out.push(path.join(nmRoot, working));

    // 4. baseUrl-like fallback：把它视为相对于工作区根的路径
    out.push(path.join(ctx.workspaceFolder.uri.fsPath, working));

    // 同时也允许 src/ 作为隐式根（很常见的 vue/react 项目结构）
    const srcRoot = path.join(ctx.workspaceFolder.uri.fsPath, 'src');
    if (fs.existsSync(srcRoot)) {
        out.push(path.join(srcRoot, working));
    }

    void strippedTilde;
    return dedup(out);
}

function applyAlias(spec: string, aliases: AliasMap): string[] {
    // 找到最长匹配的 alias 前缀
    const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        if (spec === key || spec.startsWith(key + '/') || spec.startsWith(key + path.sep)) {
            const rest = spec.substring(key.length).replace(/^[/\\]/, '');
            const targets = aliases[key];
            return targets.map(t => (rest ? path.join(t, rest) : t));
        }
    }
    return [];
}

function dedup<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

/**
 * 给定一个"基路径"（可能没扩展名、可能指向目录），尝试各种文件存在性。
 */
function findExistingFile(basePath: string, ctx: ResolveContext): string | null {
    // 1. 直接是个存在的文件
    if (existsFile(basePath)) {
        return basePath;
    }

    const dir = path.dirname(basePath);
    const name = path.basename(basePath);

    // 2. 加扩展名
    for (const ext of ctx.extensions) {
        const p = basePath + ext;
        if (existsFile(p)) {
            return p;
        }
    }

    // 3. partial（_name.scss 之类）
    if (ctx.tryPartial && !name.startsWith('_')) {
        for (const ext of ctx.extensions) {
            const p = path.join(dir, `_${name}${ext}`);
            if (existsFile(p)) {
                return p;
            }
        }
        // 也试不带扩展名直接 _xxx
        const partialDirect = path.join(dir, `_${name}`);
        if (existsFile(partialDirect)) {
            return partialDirect;
        }
    }

    // 4. 当作目录，找 index
    if (ctx.tryIndex && existsDir(basePath)) {
        for (const ext of ctx.extensions) {
            const p = path.join(basePath, `index${ext}`);
            if (existsFile(p)) {
                return p;
            }
        }
        // scss 里 _index.scss
        if (ctx.tryPartial) {
            for (const ext of ctx.extensions) {
                const p = path.join(basePath, `_index${ext}`);
                if (existsFile(p)) {
                    return p;
                }
            }
        }
    }

    return null;
}

function existsFile(p: string): boolean {
    try {
        const stat = fs.statSync(p);
        return stat.isFile();
    } catch {
        return false;
    }
}

function existsDir(p: string): boolean {
    try {
        const stat = fs.statSync(p);
        return stat.isDirectory();
    } catch {
        return false;
    }
}
