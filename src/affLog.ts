/**
 * 扩展宿主（VS Code / Cursor）的「开发者工具 → Console」或 Extension Development Host 的 Debug Console 可见。
 * 设置环境变量 ALIAS_FILE_FINDER_DEBUG=1/true 可开启。
 */
export function affLog(scope: string, ...args: unknown[]): void {
    const debug = process.env.ALIAS_FILE_FINDER_DEBUG?.toLowerCase();
    if (debug !== '1' && debug !== 'true') {
        return;
    }
    console.log('[alias-file-finder]', scope, ...args);
}
