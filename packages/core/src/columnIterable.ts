import type { IndexableIterable } from "./link";

type Key = string;
type Alias = string;
type Transformation = (x: any) => string | undefined;
type FieldSpec = [
  key: Key,
  alias: Alias,
  func: Transformation
];

export class ColumnsIterable implements IndexableIterable<string | undefined> {
  [index: number]: string | undefined;

  private readonly data: readonly Record<string, string | Date | undefined>[];
  private readonly fields: Array<FieldSpec>;

  constructor(data: readonly Record<string, string | Date | undefined>[], ...fields: Array<FieldSpec>) {
    this.data = data;
    this.fields = fields;

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) return target[Symbol.iterator].bind(target);
        if (prop === "length") return target.length;
        if (typeof prop === "string" && /^[0-9]+$/.test(prop)) {
          return target.at(Number(prop));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  *[Symbol.iterator](): Iterator<string | undefined> {
    for (const row of this.data) {
      const values = this.fields.map(([field, alias, transform]) => {
        let value = row[alias];
        if (value !== undefined) value = transform(value);
        return value === undefined ? undefined : (field + ':' + value)
      });

      yield values.includes(undefined) ? undefined : values.join(';');
    }
  }

  at(index: number): string | undefined {
    if (index < 0 || index >= this.data.length) return undefined;
    const values = this.fields.map(([field, alias, transform]) => {
      let value = this.data[index]?.[alias];
      if (value !== undefined) value = transform(value);
      return value === undefined ? undefined : (field + ':' + value)
    });
    
    return values.includes(undefined) ? undefined : values.join(';');
  }

  get length(): number {
    return this.data.length;
  }
}
