/**
 * 对齐 Worker 任务管理（主线程侧）。
 *
 *  - 每次计算都新建专用 Worker，任务成功 / 失败 / 被取代 / 组件卸载时立即
 *    terminate 释放；不使用长驻 Worker。
 *  - 启动新任务会先终止上一个任务；调用方用单调递增的任务序号（token）区分
 *    新旧任务，被取消任务迟到的成功或失败回调一律忽略，不会切换页面、覆盖
 *    新结果或清除新任务的忙碌状态。
 *  - Worker 创建失败（如浏览器不支持）与计算中失败都通过 reject 给出原因，
 *    由调用方展示并结束忙碌，已有工作区保持原样、允许再次发起。
 */
import type { ComputeRequest, ComputeResponse } from './alignWorker';

/** Worker 无法创建（环境不支持等），区别于计算本身失败，便于文案区分。 */
export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

export interface ActiveTask {
  /** 终止该任务的 Worker；重复调用安全。 */
  cancel(): void;
}

/** 跨联合成员分发的 Omit：保证按 kind 区分的请求体仍能做严格属性检查。 */
type ComputePayload<T extends ComputeRequest = ComputeRequest> = T extends unknown
  ? Omit<T, 'id'>
  : never;

/**
 * 启动一次对齐计算。返回的 task.cancel() 可随时终止；settle 只在任务未被
 * cancel / 取代时触发一次（cancel 后 Promise 永远挂起，避免迟到结果生效）。
 */
export function startCompute(
  id: number,
  payload: ComputePayload,
  settle: {
    resolve(result: ComputeResponse): void;
    reject(err: Error): void;
  },
): ActiveTask {
  let worker: Worker | null = null;
  let settled = false;
  let cancelled = false;

  const cleanup = () => {
    worker?.removeEventListener?.('message', onMessage);
    worker?.removeEventListener?.('error', onError);
    worker?.removeEventListener?.('messageerror', onMessageError);
    worker?.terminate();
    worker = null;
  };

  const onMessage = (ev: MessageEvent<ComputeResponse>) => {
    if (cancelled || settled || ev.data?.id !== id) return;
    settled = true;
    cleanup();
    settle.resolve(ev.data);
  };

  const onError = (ev: ErrorEvent) => {
    if (cancelled || settled) return;
    settled = true;
    cleanup();
    settle.reject(new Error(ev.message || '对齐 Worker 发生错误'));
  };

  const onMessageError = () => {
    if (cancelled || settled) return;
    settled = true;
    cleanup();
    settle.reject(new Error('与对齐 Worker 的消息通信失败（消息无法反序列化）'));
  };

  try {
    // ?worker 让 Vite 构建出独立的 Worker chunk；容器内由 nginx 以静态资源托管。
    worker = new Worker(new URL('./alignWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    worker = null;
    settle.reject(
      new WorkerUnavailableError(`无法创建对齐 Worker：${err instanceof Error ? err.message : String(err)}`),
    );
    return { cancel() {} };
  }

  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onMessageError);
  worker.postMessage({ ...payload, id });

  return {
    cancel() {
      if (cancelled || settled) return;
      cancelled = true;
      cleanup();
    },
  };
}

/**
 * 串行任务控制器：仅保留最新一个任务。start 会终止旧任务（旧任务的
 * resolve/reject 不再触发），返回单调递增的任务序号供调用方判定迟到结果。
 */
export class AlignTaskRunner {
  private current: ActiveTask | null = null;
  private seq = 0;

  start(
    payload: ComputePayload,
    onResolve: (res: ComputeResponse) => void,
    onReject: (err: Error) => void,
  ): number {
    this.stop();
    const id = ++this.seq;
    // 记录任务对象：Worker 创建失败时 startCompute 会同步 reject 并返回空任务，
    // 此时 this.current 仍为空，序号校验（id === this.seq）保证迟到结果不生效。
    const task = startCompute(id, payload, {
      resolve: (res) => {
        if (id !== this.seq) return;
        this.current = null;
        onResolve(res);
      },
      reject: (err) => {
        if (id !== this.seq) return;
        this.current = null;
        onReject(err);
      },
    });
    // 同步 reject（创建失败）后序号仍等于 id 才回填；下一次 start 的 stop 会
    // 对空任务安全 no-op。
    if (this.seq === id) this.current = task;
    return id;
  }

  /** 终止当前任务（如有）；终止后不再有任何回调。 */
  stop(): void {
    this.current?.cancel();
    this.current = null;
    // 序号 +1 让已 reject 的创建失败等同步回调也无法再影响新任务 / 页面状态。
    if (this.seq < Number.MAX_SAFE_INTEGER) this.seq++;
  }
}
