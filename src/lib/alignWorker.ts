/**
 * 对齐计算 Web Worker：首次对齐（含跳过/应用校准后的对齐）与重新校准时的
 * 对齐 + 迁移预览计算均在此执行；主线程只负责状态编排，计算期间页面保持可响应。
 *
 * 输入沿用本次 A/B 字幕、所选 B 时间轴与旧对齐组（见 AlignRequest / MigrateRequest），
 * 输出沿用现有对齐组与迁移方案；算法、置信度与迁移判定规则直接复用
 * alignCues / planMigration / defaultStateFor，本文件不做任何改写。
 */
import { alignCues, type AlignGroup } from './align';
import { defaultStateFor, type GroupState } from './merge';
import { planMigration, type MigrationPlan } from './migrate';
import type { Cue } from './srt';

/** 首次对齐：按选定的 B 时间轴（原始或校准后）对本次两份字幕做顺序对齐。 */
export interface AlignRequest {
  kind: 'align';
  id: number;
  cuesA: Cue[];
  cuesB: Cue[];
}

/** 迁移预览：用新 B 时间轴重新对齐，并与旧对齐组比对迁移方案。 */
export interface MigrateRequest {
  kind: 'migrate';
  id: number;
  oldGroups: AlignGroup[];
  newCuesB: Cue[];
  calibrated: boolean;
  cuesA: Cue[];
  /** 迁移文本比对始终使用原始 cuesB 文本（校准只改时间不改文本）。 */
  cuesB: Cue[];
}

export type ComputeRequest = AlignRequest | MigrateRequest;

export interface AlignResult {
  groups: AlignGroup[];
  states: GroupState[];
}

export interface MigrateResult {
  newGroups: AlignGroup[];
  newCuesB: Cue[];
  calibrated: boolean;
  plan: MigrationPlan;
}

export type ComputeResponse =
  | { id: number; ok: true; kind: 'align'; result: AlignResult }
  | { id: number; ok: true; kind: 'migrate'; result: MigrateResult }
  | { id: number; ok: false; error: string };

/** 纯计算入口：同一份逻辑既供 Worker onmessage 使用，也供单元测试直接调用。 */
export function handleAlignMessage(req: ComputeRequest): ComputeResponse {
  try {
    if (req.kind === 'align') {
      const groups = alignCues(req.cuesA, req.cuesB);
      const states = groups.map((g) => defaultStateFor(g, req.cuesA, req.cuesB));
      return { id: req.id, ok: true, kind: 'align', result: { groups, states } };
    }
    const newGroups = alignCues(req.cuesA, req.newCuesB);
    const plan = planMigration(req.oldGroups, newGroups, req.cuesA, req.cuesB);
    return {
      id: req.id,
      ok: true,
      kind: 'migrate',
      result: { newGroups, newCuesB: req.newCuesB, calibrated: req.calibrated, plan },
    };
  } catch (err) {
    return { id: req.id, ok: false, error: errorMessage(err) };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/** 同时兼容浏览器 DedicatedWorkerGlobalScope 与 Node 测试环境（window）。 */
interface MessageScope {
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  postMessage(message: ComputeResponse): void;
}

const scope = globalThis as unknown as MessageScope;
if (typeof scope.addEventListener === 'function' && typeof scope.postMessage === 'function') {
  scope.addEventListener('message', (ev: MessageEvent<ComputeRequest>) => {
    scope.postMessage(handleAlignMessage(ev.data));
  });
}
