function padLeft(string: string, chars: number, sign = '0') {
  const hasPrefix = /^0x/i.test(string) || typeof string === 'number';
  string = string.replace(/^0x/i,'');

  const padding = (chars - string.length + 1 >= 0) ? chars - string.length + 1 : 0;

  return (hasPrefix ? '0x' : '') + new Array(padding).join(sign ? sign : "0") + string;
}

export function ethAddrToBuf(address: string): Uint8Array {
  return hexToBuf(address, 20);
}

export function hexToBuf(hex: string, bytesCnt: number = 0): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }

  if (hex.startsWith('0x')) {
    hex = hex.slice(2);
  }

  if (bytesCnt > 0) {
    const digitsNum = bytesCnt * 2;
    hex = hex.slice(-digitsNum).padStart(digitsNum, '0');
  }

  const buffer = new Uint8Array(hex.length / 2);

  for (let i = 0; i < hex.length; i = i + 2) {
    buffer[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }

  return buffer;
}

export function toTwosComplementHex(num: bigint, numBytes: number): string {
  let hex;
  if (num < 0) {
    let val = BigInt(2) ** BigInt(numBytes * 8) + num;
    hex = val.toString(16)
  } else {
    hex = num.toString(16)
  }

  return padLeft(hex, numBytes * 2)
}

export function packSignature(signature: string): string {
  signature = signature.slice(2)

  if (signature.length > 128) {
    let v = signature.substr(128, 2)
    if (v == "1c") {
      return `${signature.slice(0, 64)}${(parseInt(signature[64], 16) | 8).toString(16)}${signature.slice(65, 128)}`
    } else if (v != "1b") {
      throw ("invalid signature: v should be 27 or 28")
    }

    return signature.slice(0, 128)
  } else if (signature.length < 128) {
    throw ("invalid signature: it should consist at least 64 bytes (128 chars)")
  }

  return signature
}