export class Sequence<T> {
  private mappers: ((value: T) => unknown)[] = [];

  constructor(private first: T, private getter: (value: T) => T | undefined) {}

  private iterator = function* <T>(
    first: T,
    getter: (value: T) => T | undefined,
    mappers: ((value: T) => unknown)[],
  ): Generator<unknown, void, unknown> {
    const applyMappers = (value: T): unknown =>
      mappers.reduce((prev, mapper) => mapper(prev) as T, value);

    yield applyMappers(first);

    let next = getter(first);
    while (next) {
      yield applyMappers(next);
      next = getter(next);
    }
  };

  public map<U>(mapper: (value: T) => U): Sequence<U> {
    const newSequence = new Sequence<T>(this.first, this.getter);
    newSequence.mappers.push(mapper);
    return newSequence as unknown as Sequence<U>;
  }

  public find(func: (value: T) => boolean): T | undefined {
    const iterator = this.iterator(this.first, this.getter, this.mappers);

    let next = iterator.next();
    while (!next.done) {
      if (func(next.value as T)) {
        return next.value as T;
      }
      next = iterator.next();
    }
  }

  public toArray(): T[] {
    const iterator = this.iterator(this.first, this.getter, this.mappers);

    const array: T[] = [];

    let next = iterator.next();
    while (!next.done) {
      array.push(next.value as T);
      next = iterator.next();
    }

    return array;
  }
}
