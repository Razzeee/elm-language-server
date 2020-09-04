import { container } from "tsyringe";
import {
  DocumentSymbol,
  DocumentSymbolParams,
  IConnection,
  SymbolInformation,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SyntaxNode, Tree } from "tree-sitter-elm";
import { IElmWorkspace } from "../elmWorkspace";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { SymbolInformationTranslator } from "../util/symbolTranslator";

type DocumentSymbolResult =
  | SymbolInformation[]
  | DocumentSymbol[]
  | null
  | undefined;

export class DocumentSymbolProvider {
  private connection: IConnection;

  constructor() {
    this.connection = container.resolve<IConnection>("Connection");
    this.connection.onDocumentSymbol(
      new ElmWorkspaceMatcher((param: DocumentSymbolParams) =>
        URI.parse(param.textDocument.uri),
      ).handlerForWorkspace(this.handleDocumentSymbolRequest),
    );
  }

  private handleDocumentSymbolRequest = (
    param: DocumentSymbolParams,
    elmWorkspace: IElmWorkspace,
  ): DocumentSymbolResult => {
    this.connection.console.info(`Document Symbols were requested`);
    const symbolInformationList: SymbolInformation[] = [];

    const forest = elmWorkspace.getForest();
    const tree: Tree | undefined = forest.getTree(param.textDocument.uri);

    const traverse: (node: SyntaxNode) => void = (node: SyntaxNode): void => {
      const symbolInformation = SymbolInformationTranslator.translateNodeToSymbolInformation(
        param.textDocument.uri,
        node,
      );
      if (symbolInformation) {
        symbolInformationList.push(symbolInformation);
      }

      for (const childNode of node.children) {
        traverse(childNode);
      }
    };
    if (tree) {
      traverse(tree.rootNode);
    }

    return symbolInformationList;
  };
}
