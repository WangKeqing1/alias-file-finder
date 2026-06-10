import * as vscode from 'vscode';
import { CSS_PROVIDER_SELECTORS, CssDefinitionProvider, CssLinkProvider } from './providers/cssLinkProvider';
import {
    VUE_PROVIDER_SELECTOR,
    VueComponentDefinitionProvider,
    createVueComponentIndex,
} from './providers/vueComponentProvider';
import { VueComponentHoverProvider } from './providers/vueHoverProvider';
import { VueCompletionProvider } from './providers/vueCompletionProvider';
import { createVueProvideInjectIndex } from './providers/vueProvideInjectIndex';
import { VueInjectDefinitionProvider, VueProvideReferenceProvider } from './providers/vueProvideInjectProvider';
import { clearAliasCache, getAliases } from './config/aliasResolver';
import { affLog } from './affLog';
import { clearVueParserCache } from './utils/vueParser';

export function activate(context: vscode.ExtensionContext) {
    affLog('activate', {
        appName: vscode.env.appName,
        remoteName: vscode.env.remoteName,
        extensionUri: context.extensionUri.fsPath,
    });

    // ── 功能一：CSS 路径别名跳转 ──────────────────────────────────────────
    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider(CSS_PROVIDER_SELECTORS, new CssLinkProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(CSS_PROVIDER_SELECTORS, new CssDefinitionProvider())
    );

    // ── 功能二 & 三：Vue 组件索引（共享） ───────────────────────────────
    const vueIndex = createVueComponentIndex();
    context.subscriptions.push(vueIndex);

    // 功能二：Ctrl+点击 跳转到组件文件
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            VUE_PROVIDER_SELECTOR,
            new VueComponentDefinitionProvider(vueIndex)
        )
    );

    // 功能三-Hover：鼠标悬停显示组件 JSDoc + props/emits
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            VUE_PROVIDER_SELECTOR,
            new VueComponentHoverProvider(vueIndex)
        )
    );

    // 功能三-Completion：属性补全（触发字符：空格 : @）
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            VUE_PROVIDER_SELECTOR,
            new VueCompletionProvider(vueIndex),
            ' ', ':', '@'
        )
    );

    // ── 功能四：Vue provide / inject 字符串键 ───────────────────────────
    const vueProvideInjectIndex = createVueProvideInjectIndex();
    context.subscriptions.push(vueProvideInjectIndex);
    const clearAllCaches = () => {
        clearAliasCache();
        clearVueParserCache();
        vueProvideInjectIndex.invalidate();
    };
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            VUE_PROVIDER_SELECTOR,
            new VueInjectDefinitionProvider(vueProvideInjectIndex)
        )
    );
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(
            VUE_PROVIDER_SELECTOR,
            new VueProvideReferenceProvider(vueProvideInjectIndex)
        )
    );

    // ── 配置变更 & 文件监听：清除缓存 ────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (
                e.affectsConfiguration('aliasFileFinder') ||
                e.affectsConfiguration('frontIntelligence')
            ) {
                clearAliasCache();
            }
        })
    );

    // Vue 文件修改时，清除对应解析缓存（索引本身由 watcher 维护）
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.languageId === 'vue') {
                clearVueParserCache();
                vueProvideInjectIndex.invalidate();
            }
        })
    );

    const aliasConfigWatcher = vscode.workspace.createFileSystemWatcher(
        '**/{tsconfig.json,jsconfig.json,vite.config.*,webpack.config.*,vue.config.*,nuxt.config.*,config.*}'
    );
    aliasConfigWatcher.onDidChange(() => clearAliasCache());
    aliasConfigWatcher.onDidCreate(() => clearAliasCache());
    aliasConfigWatcher.onDidDelete(() => clearAliasCache());
    context.subscriptions.push(aliasConfigWatcher);

    // ── 命令：手动清除所有缓存 ────────────────────────────────────────────
    const registerClearCacheCommand = (command: string) =>
        vscode.commands.registerCommand(command, () => {
            clearAllCaches();
            vscode.window.showInformationMessage('Front Intelligence：缓存已清除');
        });

    context.subscriptions.push(registerClearCacheCommand('frontIntelligence.clearCache'));
    context.subscriptions.push(registerClearCacheCommand('alias-file-finder.clearCache'));
    context.subscriptions.push(
        vscode.commands.registerCommand('frontIntelligence.showResolvedAliases', () => {
            const folders = vscode.workspace.workspaceFolders || [];
            if (folders.length === 0) {
                vscode.window.showInformationMessage('Front Intelligence：当前没有打开工作区文件夹');
                return;
            }
            const lines = folders.flatMap(folder => {
                const aliases = getAliases(folder);
                const entries = Object.entries(aliases);
                if (entries.length === 0) {
                    return [`${folder.name}: 未解析到路径别名`];
                }
                return [
                    `${folder.name}:`,
                    ...entries.map(([key, values]) => `  ${key} -> ${values.join(', ')}`),
                ];
            });
            vscode.window.showInformationMessage(lines.join('\n'));
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('frontIntelligence.showIndexStatus', () => {
            vscode.window.showInformationMessage('Front Intelligence：索引按需加载，当前版本提供别名和 Vue 缓存状态命令。');
        })
    );
}

export function deactivate() {}
