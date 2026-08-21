/**
 * store mutation 骨架收敛（内部 module，下划线前缀 = 非公开 store API）。
 *
 * 统一形态：begin 置位 → try fn() → catch 归一化错误写入（默认 { error: message }，
 * 可经 onError 自定义或跳过）→ finally end 复位。rethrow 选项保留各 store
 * 既有的「写 error 后再抛」语义（如 settings.save / batchPublish.submit）。
 */

/** zustand set 函数的最小签名（create 回调里的 set 可直接传入）。 */
export type SetState<T> = (
  partial: Partial<T> | ((state: T) => Partial<T>),
) => void;

export interface WithMutationOptions<T> {
  /** 进入 mutation 时的 loading 置位片段（如 { loading: true } / { deletingId: id }）。 */
  begin?: Partial<T>;
  /** finally 中的复位片段（如 { loading: false } / { deletingId: null }）。 */
  end?: Partial<T>;
  /**
   * 错误写入：缺省归一化为 { error: message }。
   * 返回 Partial 则合并写入；返回 undefined 则不写（错误由调用方自行反馈）。
   */
  onError?: (message: string, error: unknown) => Partial<T> | undefined;
  /** catch 后是否 rethrow 原异常（默认 false，仅写 error）。 */
  rethrow?: boolean;
}

export async function withMutation<T, R = void>(
  set: SetState<T>,
  fn: () => Promise<R>,
  options: WithMutationOptions<T> = {},
): Promise<R | undefined> {
  const { begin, end, onError, rethrow = false } = options;
  if (begin) set(begin);
  try {
    return await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const patch = onError ? onError(message, e) : ({ error: message } as Partial<T>);
    if (patch) set(patch);
    if (rethrow) throw e;
    return undefined;
  } finally {
    if (end) set(end);
  }
}
