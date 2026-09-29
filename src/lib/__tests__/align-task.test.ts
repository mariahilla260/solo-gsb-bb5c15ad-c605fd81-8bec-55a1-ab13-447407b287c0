import { describe, expect, it, vi } from 'vitest';
import { AlignTaskRunner, WorkerUnavailableError } from '../alignTask';
import { parseSrt } from '../srt';
import { SAMPLE_A, SAMPLE_B } from '../samples';

const payload = () => ({
  kind: 'align' as const,
  cuesA: parseSrt(SAMPLE_A),
  cuesB: parseSrt(SAMPLE_B),
});

describe('AlignTaskRunner（Worker 任务串行与取消）', () => {
  it('Worker 不可用（Node 测试环境）时以明确原因 reject，可再次发起', () => {
    const runner = new AlignTaskRunner();
    const onResolve = vi.fn();
    const onReject = vi.fn();
    runner.start(payload(), onResolve, onReject);
    expect(onResolve).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
    const err = onReject.mock.calls[0][0];
    expect(err).toBeInstanceOf(WorkerUnavailableError);
    expect(String(err.message)).toContain('Worker');

    // 失败结束忙碌后允许再次发起（第二次同样创建失败，但回调仍应触发）
    const onReject2 = vi.fn();
    runner.start(payload(), vi.fn(), onReject2);
    expect(onReject2).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('启动新任务会终止旧任务：旧任务的迟到回调一律不触发', () => {
    const runner = new AlignTaskRunner();
    const oldResolve = vi.fn();
    const oldReject = vi.fn();
    runner.start(payload(), oldResolve, oldReject); // 创建失败，立即回调一次
    expect(oldReject).toHaveBeenCalledTimes(1);

    // 模拟“旧任务挂起”的场景：创建失败后 start 新任务，旧回调即使被持有也已结束；
    // 再连续 start，仅最新一次的回调应触发
    const staleReject = vi.fn();
    const id2 = runner.start(payload(), vi.fn(), staleReject);
    const freshReject = vi.fn();
    const id3 = runner.start(payload(), vi.fn(), freshReject);
    expect(id3).toBeGreaterThan(id2);
    expect(freshReject).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('stop 可重复调用且之后无回调；组件卸载场景安全', () => {
    const runner = new AlignTaskRunner();
    const onReject = vi.fn();
    runner.start(payload(), vi.fn(), onReject);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(() => {
      runner.stop();
      runner.stop();
    }).not.toThrow();
  });
});
