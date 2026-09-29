import { describe, expect, it } from 'vitest';
import { alignCues } from '../align';
import { defaultStateFor } from '../merge';
import { planMigration } from '../migrate';
import { handleAlignMessage, type ComputeRequest } from '../alignWorker';
import { SAMPLE_A, SAMPLE_B } from '../samples';
import { parseSrt } from '../srt';

describe('对齐 Worker 计算入口', () => {
  const a = parseSrt(SAMPLE_A);
  const b = parseSrt(SAMPLE_B);

  it('align：输出与主线程 alignCues + defaultStateFor 完全一致', () => {
    const req: ComputeRequest = { kind: 'align', id: 7, cuesA: a, cuesB: b };
    const res = handleAlignMessage(req);
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'align') throw new Error('应返回 align 成功结果');
    expect(res.id).toBe(7);
    expect(res.result.groups).toEqual(alignCues(a, b));
    expect(res.result.states).toEqual(
      alignCues(a, b).map((g) => defaultStateFor(g, a, b)),
    );
  });

  it('migrate：重新对齐 + 迁移方案与现有 planMigration 判定一致', () => {
    const oldGroups = alignCues(a, b);
    const req: ComputeRequest = {
      kind: 'migrate',
      id: 3,
      oldGroups,
      newCuesB: b,
      calibrated: false,
      cuesA: a,
      cuesB: b,
    };
    const res = handleAlignMessage(req);
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'migrate') throw new Error('应返回 migrate 成功结果');
    const { newGroups, plan, calibrated, newCuesB } = res.result;
    expect(newGroups).toEqual(alignCues(a, b));
    expect(plan).toEqual(planMigration(oldGroups, newGroups, a, b));
    expect(calibrated).toBe(false);
    expect(newCuesB).toBe(b);
  });

  it('空输入返回空对齐组而不是报错', () => {
    const res = handleAlignMessage({ kind: 'align', id: 1, cuesA: [], cuesB: [] });
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'align') throw new Error('应成功');
    expect(res.result.groups).toEqual([]);
    expect(res.result.states).toEqual([]);
  });

  it('计算抛错时返回带原因的失败响应，不泄漏异常', () => {
    // 循环结构无法结构化克隆，且会触发对齐内部读取异常
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const res = handleAlignMessage({
      kind: 'align',
      id: 9,
      cuesA: cyclic as never,
      cuesB: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('应失败');
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(0);
    expect(res.id).toBe(9);
  });
});
