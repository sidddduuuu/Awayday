import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Awayday | Get us there",
  description: "A shared arrival plan for matchday.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

