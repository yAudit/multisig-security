import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "Multisig Security Checker";
const description = "Check multisig security best practices to identify improvements or risks in a multisig's configuration";

export const metadata: Metadata = {
  metadataBase: new URL("https://safe.yaudit.dev"),
  title,
  description,
  icons: {
    icon: '/icon.svg',
  },
  openGraph: {
    title,
    description,
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 633,
        alt: "Multisig Security Checker",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0657F9",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        {children}
      </body>
    </html>
  );
}
