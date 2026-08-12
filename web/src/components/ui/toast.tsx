import { useToastStore, type ToastKind } from "../../stores/toast";
import { cn } from "../../lib/utils";

const KIND_CLASS: Record<ToastKind, string> = {
  ok: "bg-success-deep",
  warn: "bg-warn-deep",
  err: "bg-danger-deep",
  info: "bg-fg",
};

/** 签名组件：toast 宿主（底部居中，语义深色档，自动消失）。 */
function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-[72px] left-1/2 z-60 flex -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={cn(
            "flex items-center gap-2 rounded-md bg-fg px-4 py-2.5 text-label font-medium text-white shadow-lg",
            "animate-toast-in",
            KIND_CLASS[t.kind],
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}

export { ToastHost };
