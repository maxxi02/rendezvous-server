export const log = {
  info: (msg: string, data?: any) =>
    console.log(`ℹ️  ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  success: (msg: string, data?: any) =>
    console.log(`✅ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  error: (msg: string, data?: any) =>
    console.error(`❌ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  warn: (msg: string, data?: any) =>
    console.warn(`⚠️  ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
};
