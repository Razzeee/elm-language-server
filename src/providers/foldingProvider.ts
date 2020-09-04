import { container } from "tsyringe";
import {
  FoldingRange,
  FoldingRangeKind,
  FoldingRangeRequestParam,
  IConnection,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SyntaxNode, Tree } from "tree-sitter-elm";
import { IElmWorkspace } from "../elmWorkspace";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";

export class FoldingRangeProvider {
  private readonly REGION_CONSTRUCTS: Set<string> = new Set([
    "case_of_expr",
    "value_declaration",
    "type_alias_declaration",
    "type_declaration",
    "record_expr",
    "case_of_branch",
    "let",
    "in",
    "if",
    "then",
    "else",
  ]);
  private connection: IConnection;
  constructor() {
    this.connection = container.resolve<IConnection>("Connection");
    this.connection.onFoldingRanges(
      new ElmWorkspaceMatcher((param: FoldingRangeRequestParam) =>
        URI.parse(param.textDocument.uri),
      ).handlerForWorkspace(this.handleFoldingRange),
    );
  }

  protected handleFoldingRange = (
    param: FoldingRangeRequestParam,
    elmWorkspace: IElmWorkspace,
  ): FoldingRange[] => {
    this.connection.console.info(`Folding ranges were requested`);
    const folds: FoldingRange[] = [];
    const forest = elmWorkspace.getForest();
    const tree: Tree | undefined = forest.getTree(param.textDocument.uri);

    const findLastIdenticalNamedSibling: (node: SyntaxNode) => SyntaxNode = (
      node: SyntaxNode,
    ): SyntaxNode => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (
          node.nextNamedSibling &&
          node.nextNamedSibling.type === "import_clause"
        ) {
          node = node.nextNamedSibling;
        } else {
          return node;
        }
      }
    };

    const traverse: (node: SyntaxNode) => void = (node: SyntaxNode): void => {
      if (node.parent && node.parent.lastChild && node.isNamed) {
        if ("import_clause" === node.type) {
          if (
            node.previousNamedSibling === null ||
            node.previousNamedSibling.type !== "import_clause"
          ) {
            const lastNode = findLastIdenticalNamedSibling(node);
            folds.push({
              endCharacter: lastNode.endPosition.column,
              endLine: lastNode.endPosition.row,
              kind: FoldingRangeKind.Imports,
              startCharacter: node.startPosition.column,
              startLine: node.startPosition.row,
            });
          }
        } else if (
          this.REGION_CONSTRUCTS.has(node.type) ||
          this.REGION_CONSTRUCTS.has(node.text)
        ) {
          folds.push({
            endCharacter: node.endPosition.column,
            endLine: node.endPosition.row,
            kind: FoldingRangeKind.Region,
            startCharacter: node.startPosition.column,
            startLine: node.startPosition.row,
          });
          // TODO: Fix once block_comment is in the typings
        } else if ("block_comment" === (node.type as unknown)) {
          folds.push({
            endCharacter: node.endPosition.column,
            endLine: node.endPosition.row,
            kind: FoldingRangeKind.Comment,
            startCharacter: node.startPosition.column,
            startLine: node.startPosition.row,
          });
        }
      }
      for (const childNode of node.children) {
        traverse(childNode);
      }
    };
    if (tree) {
      traverse(tree.rootNode);
    }

    this.connection.console.info(`Returned ${folds.length} folding ranges`);
    return folds;
  };
}
