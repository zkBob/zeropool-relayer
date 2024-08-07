const FIELDS = {
  selector: { start: 0, size: 4 },
  nullifier: { start: 4, size: 32 },
  outCommit: { start: 36, size: 32 },
  txType: { start: 640, size: 2 },
  memoSize: { start: 642, size: 2 },
  memo: { start: 644, size: 0 },
}

type Field = keyof typeof FIELDS

export class PoolCalldataParser {
  constructor(private calldata: Buffer) {}

  getField(f: Field, defaultSize?: number) {
    let { start, size } = FIELDS[f]
    size = defaultSize || size
    return '0x' + this.calldata.subarray(start, start + size).toString('hex')
  }
}

const FIELDS_V2 = {
  selector: { start: 0, size: 4 },
  nullifier: { start: 5, size: 32 },
  outCommit: { start: 37, size: 32 },
  txType: { start: 353, size: 2 },
  memoSize: { start: 355, size: 2 },
  memo: { start: 357, size: 0 },
}

type FieldV2 = keyof typeof FIELDS_V2

export class PoolCalldataV2Parser {
  constructor(private calldata: Buffer) {}

  getField(f: FieldV2, defaultSize?: number) {
    let { start, size } = FIELDS_V2[f]
    size = defaultSize || size
    return '0x' + this.calldata.subarray(start, start + size).toString('hex')
  }
}
