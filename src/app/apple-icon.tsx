import { ImageResponse } from "next/og";

// Home-screen icon: the same ">_" prompt as icon.svg, as a PNG for iOS.

export const dynamic = "force-static";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1a1b26",
        }}
      >
        <svg width="140" height="140" viewBox="0 0 32 32">
          <path
            d="M8 10 L14 16 L8 22"
            fill="none"
            stroke="#7aa2f7"
            strokeWidth="3"
            strokeLinecap="square"
          />
          <rect x="16" y="20" width="9" height="3" fill="#9ece6a" />
        </svg>
      </div>
    ),
    size,
  );
}
