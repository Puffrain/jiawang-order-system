export type BarcodeSymbology = 'EAN_13' | 'UPC_A' | 'CODE_128' | 'UNKNOWN';

export interface BarcodeCandidate {
  raw: string;
  normalized: string;
  symbology: BarcodeSymbology;
  checksumValid: boolean | null;
}

function gs1CheckDigitValid(value: string): boolean {
  const digits = value.split('').map(Number);
  const check = digits.pop();
  if (check == null || digits.some(Number.isNaN)) return false;
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function normalizeBarcode(raw: string, hinted?: BarcodeSymbology): BarcodeCandidate {
  const cleaned = raw.trim().replace(/[\s-]+/g, '');
  if (/^\d{13}$/.test(cleaned)) {
    return { raw, normalized: cleaned, symbology: 'EAN_13', checksumValid: gs1CheckDigitValid(cleaned) };
  }
  if (/^\d{12}$/.test(cleaned)) {
    return { raw, normalized: cleaned, symbology: 'UPC_A', checksumValid: gs1CheckDigitValid(cleaned) };
  }
  if (hinted === 'CODE_128' && /^[\x20-\x7E]{1,80}$/.test(cleaned)) {
    return { raw, normalized: cleaned, symbology: 'CODE_128', checksumValid: null };
  }
  return { raw, normalized: cleaned, symbology: 'UNKNOWN', checksumValid: null };
}
