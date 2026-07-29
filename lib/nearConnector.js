// Ленивый singleton коннектора кошелька (@hot-labs/near-connect).
// Библиотека трогает window/localStorage при создании — только на клиенте.

let instance = null;

export async function getConnector() {
  if (typeof window === "undefined") return null;
  if (instance) return instance;
  const { NearConnector } = await import("@hot-labs/near-connect");
  instance = new NearConnector({ network: "mainnet", autoConnect: true });
  return instance;
}
