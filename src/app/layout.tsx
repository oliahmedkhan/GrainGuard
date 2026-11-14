import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GrainGuard | Smart Storage",
  description: "Crop-aware storage management for small-scale agriculture.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
