export type ProtoValue =
  | { wireType: 0; value: bigint }
  | { wireType: 1; value: bigint }
  | { wireType: 2; value: Uint8Array }
  | { wireType: 5; value: number };

export type ProtoMessage = Map<number, ProtoValue[]>;

export function decodeProtoMessage(bytes: Uint8Array): ProtoMessage {
  const reader = new ProtoReader(bytes);
  const message: ProtoMessage = new Map();

  while (!reader.done()) {
    const tag = reader.varint();
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x07n);
    const value = reader.value(wireType);
    const values = message.get(fieldNumber) ?? [];
    values.push(value);
    message.set(fieldNumber, values);
  }

  return message;
}

export function nested(value: ProtoValue | undefined): ProtoMessage | undefined {
  if (!value || value.wireType !== 2) {
    return undefined;
  }
  return decodeProtoMessage(value.value);
}

export function repeatedNested(message: ProtoMessage, fieldNumber: number): ProtoMessage[] {
  return (message.get(fieldNumber) ?? [])
    .map((value) => nested(value))
    .filter((value): value is ProtoMessage => value !== undefined);
}

export function stringField(message: ProtoMessage, fieldNumber: number): string | undefined {
  const value = last(message, fieldNumber);
  if (!value || value.wireType !== 2) {
    return undefined;
  }
  return new TextDecoder().decode(value.value);
}

export function bytesField(message: ProtoMessage, fieldNumber: number): Uint8Array | undefined {
  const value = last(message, fieldNumber);
  if (!value || value.wireType !== 2) {
    return undefined;
  }
  return value.value;
}

export function hexBytesField(message: ProtoMessage, fieldNumber: number): string | undefined {
  const value = bytesField(message, fieldNumber);
  return value ? bytesToHex(value) : undefined;
}

export function varintField(message: ProtoMessage, fieldNumber: number): bigint | undefined {
  const value = last(message, fieldNumber);
  if (!value || value.wireType !== 0) {
    return undefined;
  }
  return value.value;
}

export function fixed64Field(message: ProtoMessage, fieldNumber: number): bigint | undefined {
  const value = last(message, fieldNumber);
  if (!value || value.wireType !== 1) {
    return undefined;
  }
  return value.value;
}

export function fixed32Field(message: ProtoMessage, fieldNumber: number): number | undefined {
  const value = last(message, fieldNumber);
  if (!value || value.wireType !== 5) {
    return undefined;
  }
  return value.value;
}

export function last(message: ProtoMessage, fieldNumber: number): ProtoValue | undefined {
  const values = message.get(fieldNumber);
  return values?.[values.length - 1];
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class ProtoReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  done() {
    return this.offset >= this.bytes.length;
  }

  varint(): bigint {
    let shift = 0n;
    let result = 0n;

    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++];
      if (byte === undefined) {
        break;
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }

    throw new Error("Invalid protobuf varint");
  }

  value(wireType: number): ProtoValue {
    if (wireType === 0) {
      return { wireType, value: this.varint() };
    }
    if (wireType === 1) {
      return { wireType, value: this.fixed64() };
    }
    if (wireType === 2) {
      const length = Number(this.varint());
      const end = this.offset + length;
      if (end > this.bytes.length) {
        throw new Error("Invalid protobuf length-delimited field");
      }
      const value = this.bytes.slice(this.offset, end);
      this.offset = end;
      return { wireType, value };
    }
    if (wireType === 5) {
      return { wireType, value: this.fixed32() };
    }

    throw new Error(`Unsupported protobuf wire type ${wireType}`);
  }

  private fixed64(): bigint {
    if (this.offset + 8 > this.bytes.length) {
      throw new Error("Invalid protobuf fixed64");
    }
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    const value = view.getBigUint64(0, true);
    this.offset += 8;
    return value;
  }

  private fixed32(): number {
    if (this.offset + 4 > this.bytes.length) {
      throw new Error("Invalid protobuf fixed32");
    }
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    const value = view.getUint32(0, true);
    this.offset += 4;
    return value;
  }
}
