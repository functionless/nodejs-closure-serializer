export function globalSingleton<T>(key: symbol, create: () => T): T {
  return ((global as any)[key] = (global as any)[key] ?? create());
}
