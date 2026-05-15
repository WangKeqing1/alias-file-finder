import * as fs from 'fs';
import * as vscode from 'vscode';
import { scanVueProvideInjectKeys, type ProvideInjectKeySite } from '../utils/vueProvideInjectScan';

function offsetToPosition(text: string, offset: number): vscode.Position {
    const o = Math.min(Math.max(0, offset), text.length);
    const before = text.slice(0, o);
    const lines = before.split(/\r?\n/);
    const line = lines.length - 1;
    const character = lines[lines.length - 1]!.length;
    return new vscode.Position(line, character);
}

function siteToLocation(uri: vscode.Uri, fileText: string, site: ProvideInjectKeySite): vscode.Location {
    const start = offsetToPosition(fileText, site.start);
    const end = offsetToPosition(fileText, site.end);
    return new vscode.Location(uri, new vscode.Range(start, end));
}

export class VueProvideInjectIndex implements vscode.Disposable {
    private provideByKey = new Map<string, vscode.Location[]>();
    private injectByKey = new Map<string, vscode.Location[]>();
    private ready: Promise<void> | null = null;
    private watcher?: vscode.FileSystemWatcher;
    private debounce?: ReturnType<typeof setTimeout>;

    initialize(): void {
        this.ready = this.rebuild();
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.vue');
        const bump = () => this.scheduleRebuild();
        this.watcher.onDidCreate(bump);
        this.watcher.onDidDelete(bump);
        this.watcher.onDidChange(bump);
    }

    dispose(): void {
        this.watcher?.dispose();
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
    }

    /** 下次 ensureReady 会强制重建（用于手动清缓存） */
    invalidate(): void {
        this.ready = null;
    }

    ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = this.rebuild();
        }
        return this.ready;
    }

    findProvideLocations(key: string): vscode.Location[] {
        const list = this.provideByKey.get(key);
        return list ? [...list] : [];
    }

    findInjectLocations(key: string): vscode.Location[] {
        const list = this.injectByKey.get(key);
        return list ? [...list] : [];
    }

    private scheduleRebuild(): void {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        this.debounce = setTimeout(() => {
            this.debounce = undefined;
            this.ready = this.rebuild();
        }, 250);
    }

    private push(map: Map<string, vscode.Location[]>, key: string, loc: vscode.Location): void {
        const list = map.get(key);
        if (list) {
            list.push(loc);
        } else {
            map.set(key, [loc]);
        }
    }

    private async rebuild(): Promise<void> {
        this.provideByKey.clear();
        this.injectByKey.clear();
        try {
            const uris = await vscode.workspace.findFiles(
                '**/*.vue',
                '**/{node_modules,dist,build,out,.git,.next,.nuxt,.output,coverage}/**',
                5000
            );
            for (const uri of uris) {
                let text: string;
                try {
                    text = fs.readFileSync(uri.fsPath, 'utf-8');
                } catch {
                    continue;
                }
                const sites = scanVueProvideInjectKeys(text);
                for (const s of sites) {
                    const loc = siteToLocation(uri, text, s);
                    if (s.kind === 'provide') {
                        this.push(this.provideByKey, s.key, loc);
                    } else {
                        this.push(this.injectByKey, s.key, loc);
                    }
                }
            }
        } catch {
            // ignore
        }
    }
}

export function createVueProvideInjectIndex(): VueProvideInjectIndex {
    const idx = new VueProvideInjectIndex();
    idx.initialize();
    return idx;
}
