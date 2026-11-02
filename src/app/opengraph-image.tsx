import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { profile } from "@/content/profile";
import { SITE_URL } from "@/lib/site";

// Link preview in the site's retro terminal look (Tokyo Night palette, VT323).
// Generated at build time into the static export.

export const dynamic = "force-static";
export const alt = `${profile.name} — ${profile.title}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const c = {
  bg: "#1a1b26",
  bgDark: "#16161e",
  border: "#2f3549",
  fg: "#c0caf5",
  comment: "#565f89",
  blue: "#7aa2f7",
  green: "#9ece6a",
  magenta: "#bb9af7",
  red: "#f7768e",
  yellow: "#e0af68",
};

export default async function Image() {
  const vt323 = await readFile(join(process.cwd(), "assets/VT323-Regular.ttf"));
  const host = new URL(SITE_URL).host;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          padding: 48,
          background: c.bgDark,
          backgroundImage: `linear-gradient(${c.border} 1px, transparent 1px), linear-gradient(90deg, ${c.border} 1px, transparent 1px)`,
          backgroundSize: "40px 40px",
          fontFamily: "VT323",
          color: c.fg,
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: c.bg,
            border: `2px solid ${c.border}`,
            borderRadius: 12,
            boxShadow: `0 0 60px rgba(122,162,247,0.35)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "16px 24px",
              borderBottom: `2px solid ${c.border}`,
              fontSize: 30,
              color: c.comment,
            }}
          >
            <div style={{ width: 18, height: 18, borderRadius: 9, background: c.red }} />
            <div style={{ width: 18, height: 18, borderRadius: 9, background: c.yellow }} />
            <div style={{ width: 18, height: 18, borderRadius: 9, background: c.green }} />
            <div style={{ marginLeft: 16 }}>{`${profile.handle}@${host}: ~`}</div>
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "0 56px",
            }}
          >
            <div style={{ display: "flex", fontSize: 40, color: c.comment }}>
              <span style={{ color: c.green }}>$</span>
              <span style={{ marginLeft: 14 }}>whoami</span>
            </div>
            <div style={{ fontSize: 120, lineHeight: 1, color: c.blue, marginTop: 8 }}>
              {profile.name}
            </div>
            <div style={{ fontSize: 46, color: c.magenta, marginTop: 20 }}>
              {profile.title}
            </div>
            <div style={{ display: "flex", fontSize: 40, marginTop: 40 }}>
              <span style={{ color: c.green }}>$</span>
              <span style={{ marginLeft: 14, color: c.fg }}>{host}</span>
              <span
                style={{ width: 22, height: 38, marginLeft: 8, background: c.fg }}
              />
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "VT323", data: vt323, style: "normal", weight: 400 }],
    },
  );
}
