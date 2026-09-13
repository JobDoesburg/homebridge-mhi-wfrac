/**
 * CRC16-CCITT as used by the WF-RAC airconStat blob: polynomial 0x1021, initial value 0xFFFF,
 * no reflection, no final XOR. Each block of the blob (state + segment count + segments) carries
 * its own CRC, appended little-endian.
 */
export function crc16ccitt(data: readonly number[]): number {
  let crc = 0xFFFF;
  for (const value of data) {
    const byte = value & 0xFF;
    for (let bit = 0; bit < 8; bit++) {
      const inputBit = ((byte >> (7 - bit)) & 1) === 1;
      const topBit = ((crc >> 15) & 1) === 1;
      crc = (crc << 1) & 0xFFFF;
      if (inputBit !== topBit) {
        crc ^= 0x1021;
      }
    }
  }
  return crc;
}

export function appendCrc16(data: readonly number[]): number[] {
  const crc = crc16ccitt(data);
  return [...data, crc & 0xFF, (crc >> 8) & 0xFF];
}
