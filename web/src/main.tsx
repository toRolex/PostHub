import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { loadApplicationRoot } from "./bootstrap";
import { prototypeExitUrl, resolvePrototype } from "./prototypeRoute";
import "./index.css";

function exitPrototype(): void {
  window.location.assign(prototypeExitUrl(window.location.href));
}

async function loadRoot(): Promise<ReactElement> {
  if (import.meta.env.DEV) {
    const prototype = resolvePrototype(window.location.search, true);
    if (prototype) {
      return loadApplicationRoot(prototype, {
        app: async () => {
          throw new Error("DEV 原型分派不应加载正式应用");
        },
        timePicker: async () => {
          const { TimePickerPrototype } = await import("./prototypes/TimePickerPrototype");
          return <TimePickerPrototype onExit={exitPrototype} />;
        },
        batchRun: async () => {
          const { BatchRunUiPrototype } = await import("./prototypes/BatchRunUiPrototype");
          return <BatchRunUiPrototype onExit={exitPrototype} />;
        },
      });
    }
  }
  const { default: App } = await import("./App");
  return <App />;
}

const root = createRoot(document.getElementById("root")!);

void loadRoot()
  .then((element) => {
    root.render(<StrictMode>{element}</StrictMode>);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <main className="grid min-h-screen place-items-center bg-bg p-6 text-fg">
        <section role="alert" className="max-w-xl rounded-lg border border-danger bg-danger-tint p-5">
          <h1 className="text-title font-semibold text-danger-deep">页面加载失败</h1>
          <p className="mt-2 text-label text-danger-deep">{message}</p>
        </section>
      </main>,
    );
  });
