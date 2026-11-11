import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DIY Sandbox",
  description: "Take machines apart in 3D and put them back together.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
