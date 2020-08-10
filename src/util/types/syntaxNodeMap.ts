/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import { SyntaxNode } from "web-tree-sitter";

export class SyntaxNodeMap<K extends SyntaxNode, V> {
  private map: Map<K, V> = new Map<K, V>();

  public set(key: K, value: V): void {
    if (!("id" in key)) {
      throw new Error("SyntaxNodeMap key must have an `id` property");
    }

    this.map.set((<any>key).id, value);
  }

  public get(key: K): V | undefined {
    if (!("id" in key)) {
      throw new Error("SyntaxNodeMap key must have an `id` property");
    }

    return this.map.get((<any>key).id);
  }

  public has(key: K): boolean {
    if (!("id" in key)) {
      throw new Error("SyntaxNodeMap key must have an `id` property");
    }

    return this.map.has((<any>key).id);
  }

  public mapValues(callback: (value: V) => V): void {
    this.map.forEach((val, key) => {
      this.map.set(key, callback(val));
    });
  }
}
