import type { Metadata } from "next";
import { Geist, JetBrains_Mono, VT323 } from "next/font/google";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const vt323 = VT323({
  variable: "--font-vt323",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://albertocarbonell.dev"),
  title: "Alberto Carbonell — AI agent engineer",
  description:
    "Portfolio of Alberto Carbonell, software engineer building AI agents with TypeScript, React and LLMs.",
  openGraph: {
    title: "Alberto Carbonell — AI agent engineer",
    url: "https://albertocarbonell.dev",
    siteName: "albertocarbonell.dev",
    type: "website",
  },
};

// Applies the saved theme before first paint to avoid a flash.
const themeScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="night")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="night"
      suppressHydrationWarning
      className={`${geistSans.variable} ${jetbrainsMono.variable} ${vt323.variable} antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="bg-grid min-h-screen font-mono">{children}</body>
    </html>
  );
}
