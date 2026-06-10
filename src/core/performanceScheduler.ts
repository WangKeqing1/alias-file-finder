import * as os from 'os';
import type { BackgroundIndexingMode, PerformanceMode } from '../config/settingsService';

export interface RawPerformanceSettings {
    mode: PerformanceMode;
    maxWorkers: number;
    backgroundIndexing: BackgroundIndexingMode;
}

export interface ResolvedPerformanceProfile {
    mode: PerformanceMode;
    workerCount: number;
    backgroundIndexing: BackgroundIndexingMode;
    batchSize: number;
    idleDelayMs: number;
}

export function resolvePerformanceProfile(
    settings: RawPerformanceSettings
): ResolvedPerformanceProfile {
    const cpuCount = Math.max(1, os.cpus().length || 1);
    const automaticWorkers = automaticWorkerCount(settings.mode, cpuCount);
    const workerCount = settings.maxWorkers > 0
        ? Math.min(settings.maxWorkers, Math.max(1, cpuCount))
        : automaticWorkers;

    return {
        mode: settings.mode,
        workerCount,
        backgroundIndexing: resolveBackgroundIndexing(settings),
        batchSize: resolveBatchSize(settings.mode),
        idleDelayMs: resolveIdleDelay(settings.mode),
    };
}

function automaticWorkerCount(mode: PerformanceMode, cpuCount: number): number {
    switch (mode) {
        case 'lowPower':
            return 1;
        case 'highPerformance':
            return Math.max(2, Math.min(cpuCount - 1, 8));
        case 'balanced':
            return Math.max(1, Math.min(Math.ceil(cpuCount / 3), 4));
    }
}

function resolveBackgroundIndexing(
    settings: RawPerformanceSettings
): BackgroundIndexingMode {
    if (settings.backgroundIndexing !== 'auto') {
        return settings.backgroundIndexing;
    }
    if (settings.mode === 'lowPower') {
        return 'off';
    }
    if (settings.mode === 'highPerformance') {
        return 'aggressive';
    }
    return 'auto';
}

function resolveBatchSize(mode: PerformanceMode): number {
    switch (mode) {
        case 'lowPower':
            return 15;
        case 'highPerformance':
            return 80;
        case 'balanced':
            return 40;
    }
}

function resolveIdleDelay(mode: PerformanceMode): number {
    switch (mode) {
        case 'lowPower':
            return 1000;
        case 'highPerformance':
            return 100;
        case 'balanced':
            return 350;
    }
}
