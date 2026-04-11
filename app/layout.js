import "./globals.css";

export const metadata = {
  title: "Darai NFT Staking Calculator",
  description: "Распределение наград стейкинга по держателям Darai NFT",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
