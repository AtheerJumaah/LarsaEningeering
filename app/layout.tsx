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
  /* The app's own background, not black. This is what the browser paints the
     installed window's title bar with, and a black strip above a near-white
     app reads as a separate band rather than the top of the app. The page
     keeps this in step with the light/dark toggle at runtime. */
  themeColor: "#f7f7f5",
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
        {/* Chrome, Edge and Android announce "this app can be installed" exactly
            once, with a beforeinstallprompt event fired as soon as the manifest
            and service worker are read — normally well before a page this size
            has hydrated. The event is not queued: if nothing is listening at
            that instant it is gone for the rest of the visit, and Install then
            has nothing to call and can only fall back to the manual steps.
            This runs in the document head, ahead of React, parks the event on
            window, and tells the app it has arrived. iOS Safari never fires it
            and exposes no install API at all, which is why Add to Home Screen
            remains the honest answer there. */}
        <script
          id="larsa-install-capture"
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var s=window.__larsaInstall={event:null,installed:false};' +
              'window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();' +
              's.event=e;window.dispatchEvent(new CustomEvent("larsa:installable"));});' +
              'window.addEventListener("appinstalled",function(){s.event=null;s.installed=true;});' +
              "}catch(e){}})();",
          }}
        />
      </head>
      <body>{children}<CardTools /></body>
    </html>
  );
}
