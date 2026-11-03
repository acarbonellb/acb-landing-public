"use client";

// PROTOTYPE, throwaway. Two design questions on the real home page:
//   ?title=  how the hero name and section numbers are set (less arcade)
//   ?green=  a softer Tokyo Night green for strings
// The switcher only writes data attributes on <html>; the looks live in
// `src/app/prototype-variants.css`. Never rendered in production builds.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

type Axis = {
  param: "title" | "green";
  label: string;
  variants: Record<string, string>;
};

const axes: Axis[] = [
  {
    param: "title",
    label: "título",
    variants: {
      A: "actual · VT323 + glow",
      B: "JetBrains Mono bold",
      C: "IBM Plex Mono",
      D: "Geist Sans",
    },
  },
  {
    param: "green",
    label: "verde",
    variants: {
      A: "actual #9ece6a · 9.8:1",
      B: "suave #8db87a · 7.9:1",
      C: "salvia #9aa98a · 7.2:1",
      D: "apagado #7fa46a · 6.4:1",
    },
  },
];

function current(axis: Axis, params: URLSearchParams) {
  const value = params.get(axis.param) ?? "A";
  return value in axis.variants ? value : "A";
}

export function PrototypeSwitcher() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const step = (axis: Axis, delta: number) => {
    const keys = Object.keys(axis.variants);
    const params = new URLSearchParams(searchParams.toString());
    const i = keys.indexOf(current(axis, params));
    params.set(axis.param, keys[(i + delta + keys.length) % keys.length]);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    for (const axis of axes) {
      document.documentElement.dataset[`proto${axis.param[0].toUpperCase()}${axis.param.slice(1)}`] =
        current(axis, new URLSearchParams(searchParams.toString()));
    }
  }, [searchParams]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      step(e.shiftKey ? axes[1] : axes[0], e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-14 left-1/2 z-[200] flex -translate-x-1/2 flex-col gap-1 rounded-xl bg-white px-3 py-2 font-sans text-sm text-black shadow-2xl ring-1 ring-black/20">
      {axes.map((axis) => {
        const key = current(axis, new URLSearchParams(searchParams.toString()));
        return (
          <div key={axis.param} className="flex items-center gap-2">
            <span className="w-12 text-xs text-neutral-500">{axis.label}</span>
            <button
              type="button"
              onClick={() => step(axis, -1)}
              className="rounded px-2 hover:bg-neutral-200"
            >
              ←
            </button>
            <span className="w-56 text-center">
              <b>{key}</b> · {axis.variants[key]}
            </span>
            <button
              type="button"
              onClick={() => step(axis, 1)}
              className="rounded px-2 hover:bg-neutral-200"
            >
              →
            </button>
          </div>
        );
      })}
      <p className="text-center text-[10px] text-neutral-500">
        ←/→ título · shift+←/→ verde
      </p>
    </div>
  );
}
