/**
 * tags 输入态解析（唯一实现）。
 * 单视频发布表单与批量矩阵共用；`if (!raw)` 防御兼容 falsy 输入调用点。
 */
export function parseTags(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,，]+/)
    .map((t) => t.replace(/^#+/, "").trim())
    .filter(Boolean);
}
