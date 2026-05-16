import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Employees for D2C",
  description: "A zero-human ops stack. v0.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
