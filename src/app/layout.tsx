import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Intelligence OS",
  description: "Intelligence personnelle — V0.1",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
