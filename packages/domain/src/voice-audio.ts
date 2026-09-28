/** Bounded Ogg Opus envelope/timing inspection, not acoustic decoding. RFC 7845/6716. */
export interface VoiceAudioInspection {
  version: 'ogg-opus-v1'; mediaType: 'audio/ogg'; channels: number;
  durationSeconds: number; encodedSamples: number; sampleRate: 48000;
}
export class VoiceAudioError extends Error {}
const reject = (): never => { throw new VoiceAudioError('Unsupported or malformed Ogg Opus voice recording'); };
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
function packetSamples(packet: Uint8Array): number {
  if (!packet.length) return reject();
  const config = packet[0] >> 3, code = packet[0] & 3;
  const samples = config < 12 ? [480, 960, 1920, 2880][config & 3]
    : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const frames = code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1] & 63 : 0;
  if (!frames || frames > 48 || frames * samples > 5760) return reject();
  return frames * samples;
}

export function inspectVoiceAudio(bytes: Uint8Array): VoiceAudioInspection {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) return reject();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0, sequence = 0, serial: number | undefined, packets = 0, channels = 0, preSkip = 0;
  let encodedSamples = 0, lastGranule = 0, ended = false, pendingSize = 0;
  let pending: Uint8Array[] = [];
  while (offset < bytes.length) {
    if (ended || offset + 27 > bytes.length || ascii(bytes, offset, offset + 4) !== 'OggS' || bytes[offset + 4] !== 0) return reject();
    const flags = bytes[offset + 5], segments = bytes[offset + 26], headerEnd = offset + 27 + segments;
    if (!segments || headerEnd > bytes.length || flags & ~7 || Boolean(flags & 1) !== Boolean(pendingSize) ||
      Boolean(flags & 2) !== (sequence === 0) || view.getUint32(offset + 18, true) !== sequence) return reject();
    const pageSerial = view.getUint32(offset + 14, true);
    if (serial !== undefined && pageSerial !== serial) return reject();
    serial = pageSerial;
    let bodyLength = 0;
    for (let s = offset + 27; s < headerEnd; s++) bodyLength += bytes[s];
    const pageEnd = headerEnd + bodyLength;
    if (pageEnd > bytes.length) return reject();
    let crc = 0;
    for (let i = offset; i < pageEnd; i++) {
      const value = i >= offset + 22 && i < offset + 26 ? 0 : bytes[i];
      crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ value) & 255]) >>> 0;
    }
    if (crc !== view.getUint32(offset + 22, true)) return reject();
    const beforePackets = packets, beforeSamples = encodedSamples;
    let data = headerEnd;
    for (let s = offset + 27; s < headerEnd; s++) {
      const size = bytes[s]; pending.push(bytes.subarray(data, data + size)); pendingSize += size; data += size;
      if (pendingSize > 65_536) return reject();
      if (size === 255) continue;
      const packet = new Uint8Array(pendingSize); let at = 0;
      for (const part of pending) { packet.set(part, at); at += part.length; }
      pending = []; pendingSize = 0;
      if (packets === 0) {
        if (sequence !== 0 || segments !== 1 || packet.length !== 19 || ascii(packet, 0, 8) !== 'OpusHead' ||
            packet[8] !== 1 || ![1, 2].includes(packet[9]) || packet[18] !== 0) return reject();
        channels = packet[9]; preSkip = packet[10] | (packet[11] << 8);
      } else if (packets === 1) {
        if (packet.length < 16 || ascii(packet, 0, 8) !== 'OpusTags' || s !== headerEnd - 1) return reject();
      } else {
        encodedSamples += packetSamples(packet);
        if (encodedSamples > 600 * 48_000) throw new VoiceAudioError('Voice recording exceeds ten minutes of encoded audio');
      }
      packets++;
    }
    const granule = view.getBigUint64(offset + 6, true);
    ended = Boolean(flags & 4);
    if (packets <= 2) {
      if (granule !== 0n || ended) return reject();
    } else if (packets === beforePackets) {
      if (granule !== 0xffffffffffffffffn || ended) return reject();
    } else {
      if (granule > BigInt(encodedSamples) || granule < BigInt(lastGranule) ||
          (!ended && granule !== BigInt(encodedSamples)) || (ended && granule < BigInt(beforeSamples))) return reject();
      lastGranule = Number(granule);
    }
    if (ended && pendingSize) return reject();
    offset = pageEnd; sequence++;
  }
  if (!ended || packets < 3 || pendingSize || lastGranule <= preSkip) return reject();
  return { version: 'ogg-opus-v1', mediaType: 'audio/ogg', channels,
    durationSeconds: (lastGranule - preSkip) / 48_000, encodedSamples, sampleRate: 48_000 };
}
