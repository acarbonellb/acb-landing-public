"use client";

import { useEffect, useRef, useState } from "react";
import { revealEmail } from "@/lib/obfuscated-email";

const linkStyle =
  "mt-6 inline-block max-w-full text-lg font-bold break-all text-blue underline decoration-border underline-offset-8 transition-colors hover:decoration-blue sm:text-2xl";

/**
 * Shows a button until the visitor asks for the address, so it is built
 * only in the browser and only on a click (see obfuscated-email.ts).
 */
export function ContactEmail({ obfuscated }: { obfuscated: string }) {
  const [email, setEmail] = useState<string | null>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);

  // The button the visitor pressed is gone; keep keyboard focus in place.
  useEffect(() => {
    if (email) linkRef.current?.focus();
  }, [email]);

  if (!email) {
    return (
      <button
        type="button"
        onClick={() => setEmail(revealEmail(obfuscated))}
        className={`${linkStyle} cursor-pointer`}
      >
        show email
      </button>
    );
  }

  return (
    <a ref={linkRef} href={`mailto:${email}`} className={linkStyle}>
      {email}
    </a>
  );
}
