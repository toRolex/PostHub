import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";
import type {
  DouyinDeclaration,
  PlatformFields,
  WechatDeclaration,
  XiaohongshuSource,
} from "../../api/declarations";
import {
  DOUYIN_DECLARATIONS,
  WECHAT_DECLARATIONS,
  XIAOHONGSHU_SOURCES,
  renderDeclarationLabel,
} from "../../api/declarations";

const NONE_VALUE = "__none__";

function toSelectValue(v: string | undefined): string {
  return v ?? NONE_VALUE;
}

function fromSelectValue(v: string): string | undefined {
  return v === NONE_VALUE ? undefined : v;
}

function OriginSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      <span className="text-label text-fg-2">{label}</span>
    </div>
  );
}

/** 单平台声明编辑块：按平台独立显示对应候选下拉 + 原创开关（如适用）。 */
export function PlatformDeclarationPicker({
  platform,
  value,
  onChange,
}: {
  platform: "wechat" | "douyin" | "xiaohongshu";
  value: PlatformFields[keyof PlatformFields];
  onChange: (next: PlatformFields[keyof PlatformFields]) => void;
}) {
  if (platform === "douyin") {
    const cur = (value as { declaration?: DouyinDeclaration } | undefined)?.declaration;
    return (
      <div className="flex flex-col gap-1.5">
        <Label>自主声明</Label>
        <Select
          value={toSelectValue(cur)}
          onValueChange={(v) =>
            onChange({ declaration: fromSelectValue(v) as DouyinDeclaration | undefined })
          }
        >
          <SelectTrigger aria-label="抖音自主声明">
            <SelectValue placeholder="账号默认" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>（账号默认）</SelectItem>
            {DOUYIN_DECLARATIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (platform === "xiaohongshu") {
    const cur = (value as { source?: XiaohongshuSource; origin?: boolean } | undefined);
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1.5">
          <Label>添加内容类型声明</Label>
          <Select
            value={toSelectValue(cur?.source)}
            onValueChange={(v) =>
              onChange({
                source: fromSelectValue(v) as XiaohongshuSource | undefined,
                origin: cur?.origin,
              })
            }
          >
            <SelectTrigger aria-label="小红书内容类型声明">
              <SelectValue placeholder="账号默认" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>（账号默认）</SelectItem>
              {XIAOHONGSHU_SOURCES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <OriginSwitch
          label="声明原创"
          checked={!!cur?.origin}
          onCheckedChange={(b) => onChange({ ...cur, origin: b })}
        />
      </div>
    );
  }

  // wechat
  const cur = (value as { declaration?: WechatDeclaration; origin?: boolean } | undefined);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <Label>添加声明</Label>
        <Select
          value={toSelectValue(cur?.declaration)}
          onValueChange={(v) =>
            onChange({
              declaration: fromSelectValue(v) as WechatDeclaration | undefined,
              origin: cur?.origin,
            })
          }
        >
          <SelectTrigger aria-label="视频号添加声明">
            <SelectValue placeholder="账号默认" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>（账号默认）</SelectItem>
            {WECHAT_DECLARATIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <OriginSwitch
        label="声明原创"
        checked={!!cur?.origin}
        onCheckedChange={(b) => onChange({ ...cur, origin: b })}
      />
    </div>
  );
}

/** 平台徽标：发布结果 / 详情展示当前平台声明值。 */
export function PlatformDeclarationBadge({
  platform,
  value,
}: {
  platform: "wechat" | "douyin" | "xiaohongshu";
  value: PlatformFields[keyof PlatformFields] | undefined;
}) {
  const label = renderDeclarationLabel(platform, value);
  const hasExplicit = !!value && label !== "账号默认";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-caption",
        hasExplicit
          ? "bg-accent-tint text-accent-ink"
          : "bg-surface-warm text-meta",
      )}
    >
      {label}
    </span>
  );
}

