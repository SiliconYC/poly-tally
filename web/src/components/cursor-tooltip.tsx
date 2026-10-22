import { useLayoutEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  flip,
  hide,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react-dom";

export function CursorTooltip({
  anchor,
  contextElement,
  children,
}: {
  anchor: { x: number; y: number };
  contextElement: HTMLElement | null;
  children: ReactNode;
}) {
  const middleware = useMemo(
    () => [
      offset(18),
      flip({ fallbackPlacements: ["bottom-start", "left-start"] }),
      shift({ padding: 12 }),
      hide(),
    ],
    [],
  );
  const { refs, floatingStyles, middlewareData } = useFloating({
    placement: "top-start",
    strategy: "fixed",
    middleware,
    whileElementsMounted: autoUpdate,
  });
  useLayoutEffect(() => {
    // Keep the point attached to the chart so scroll updates can hide it offscreen.
    const rect = contextElement?.getBoundingClientRect();
    const local = {
      x: anchor.x - (rect?.left ?? 0),
      y: anchor.y - (rect?.top ?? 0),
    };
    refs.setReference({
      contextElement: contextElement ?? undefined,
      getBoundingClientRect: () => {
        const current = contextElement?.getBoundingClientRect();
        return new DOMRect(
          (current?.left ?? 0) + local.x,
          (current?.top ?? 0) + local.y,
          0,
          0,
        );
      },
    });
  }, [anchor, contextElement, refs]);
  return createPortal(
    <div
      ref={refs.setFloating}
      style={{
        ...floatingStyles,
        visibility: middlewareData.hide?.referenceHidden ? "hidden" : "visible",
      }}
      role="status"
      aria-label="历史快照提示"
      className="pointer-events-none z-50 max-w-[min(280px,calc(100vw-24px))] rounded-lg border border-border/70 bg-popover px-3.5 py-3 text-xs text-popover-foreground shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}
