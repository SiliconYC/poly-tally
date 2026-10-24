import { useLayoutEffect, useState, type RefObject } from "react";

/** Width changes affect tick density, not data/hover state. */
export function usePlotWidth(ref: RefObject<HTMLElement | null>, fallback = 320): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const measured = element.getBoundingClientRect().width || element.clientWidth;
      if (Number.isFinite(measured) && measured > 0) setWidth(Math.round(measured));
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref]);
  return width;
}
