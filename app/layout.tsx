import type { Metadata } from "next";
import { Press_Start_2P, Space_Mono, Baloo_2, Manrope } from "next/font/google";
import "./globals.css";

const pressStart2P = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pixel",
  adjustFontFallback: false,
});
const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-space-mono",
  adjustFontFallback: false,
});
const baloo2 = Baloo_2({
  weight: ["400", "600", "700", "800"],
  subsets: ["latin"],
  variable: "--font-display",
  adjustFontFallback: false,
});
const manrope = Manrope({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-body",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "KiranaCrew",
  description: "Voice-first autonomous AI workforce for Indian kirana stores",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${pressStart2P.variable} ${spaceMono.variable} ${baloo2.variable} ${manrope.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
