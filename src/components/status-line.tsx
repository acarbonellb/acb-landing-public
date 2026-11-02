import { profile } from "@/content/profile";

// Footer styled like a vim/lualine status line.
export function StatusLine() {
  return (
    <footer className="mt-16 border-t border-border bg-bg-dark text-xs">
      <div className="mx-auto flex max-w-5xl flex-wrap items-stretch px-4 sm:px-6">
        <span className="bg-green px-2 py-1.5 font-bold text-bg">NORMAL</span>
        <span className="bg-bg-highlight px-2 py-1.5 text-fg"> main</span>
        <span className="px-2 py-1.5 text-comment">
          © {profile.name}
        </span>
        <span className="ml-auto hidden px-2 py-1.5 text-comment sm:inline">
          utf-8 · tsx · next.js
        </span>
        <span className="bg-blue px-2 py-1.5 font-bold text-bg">100%</span>
      </div>
    </footer>
  );
}
