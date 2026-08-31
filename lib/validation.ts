export const normalizePhone = (value: unknown) => String(value ?? "").replace(/\D/g, "");
export const isPhone = (value: string) => /^1\d{10}$/.test(value);
export const isSafeReturnPath = (value: unknown) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
export const isSixDigitCode = (value: unknown) => /^\d{6}$/.test(String(value ?? ""));
export const cleanText = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);
export const positiveInt = (value: unknown, max = 9999) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= max ? number : null;
};
