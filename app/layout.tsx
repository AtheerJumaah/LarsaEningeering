import type { Metadata, Viewport } from "next";
import "./globals.css"; import "./visual-pass.css"; import { CardTools } from "./CardTools";

export const metadata: Metadata = {
  title: "Larsa Control",
  description: "Larsa Engineering timeclock, performance, development, HR, projects, and accounting operations.",
  applicationName: "Larsa Control",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Larsa Control",
  },
  formatDetection: { telephone: false },
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48", type: "image/x-icon" },
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/* Installed on an iPhone the app runs full-bleed, and the status bar is set to
   black-translucent, so without viewport-fit=cover iOS gives no safe-area
   insets and the top bar slides under the clock and the notch. Declaring the
   viewport explicitly also stops the app depending on a framework default.
   maximumScale is left alone on purpose: locking zoom breaks accessibility. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>{children}<CardTools /></body>
    </html>
  );
}
