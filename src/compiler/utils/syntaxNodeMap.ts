import { SyntaxNode } from "web-tree-sitter";

export class SyntaxNodeMap<K extends SyntaxNode, V> {
  private map: Map<number, V> = new Map<number, V>();

  public set(key: K, value: V): void {
    this.map.set(key.id, value);
  }

  public get(key: K): V | undefined {
    return this.map.get(key.id);
  }

  public getOrSet(key: K, setter: () => V): V {
    const existing = this.get(key);

    if (existing) {
      return existing;
    }

    const result = setter();

    this.set(key, result);
    return result;
  }

  public has(key: K): boolean {
    return this.map.has(key.id);
  }

  public mapValues(callback: (value: V) => V): void {
    this.map.forEach((val, key) => {
      this.map.set(key, callback(val));
    });
  }

  public forEach(callback: (val: V, key: K) => void): void {
    this.map.forEach((val, key) => callback(val, { id: key } as unknown as K));
  }

  public clear(): void {
    this.map.clear();
  }

  public delete(key: K): void {
    this.map.delete(key.id);
  }
}
