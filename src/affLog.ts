/**
 * 扩展宿主（VS Code / Cursor）的「开发者工具 → Console」或 Extension Development Host 的 Debug Console 可见。
 * 设置环境变量 ALIAS_FILE_FINDER_DEBUG=0 可关闭（默认开启，便于排查 Cursor 与 VS Code 差异）。
 */
export function affLog(scope: string, ...args: unknown[]): void {
    if (process.env.ALIAS_FILE_FINDER_DEBUG === '0') {
        return;
    }
    console.log('[alias-file-finder]', scope, ...args);
}
