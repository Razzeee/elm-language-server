import { container } from "tsyringe";
import {
  CancellationToken,
  DocumentSymbol,
  DocumentSymbolParams,
  Connection,
  SymbolInformation,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SyntaxNode, Tree } from "web-tree-sitter";
import { ElmWorkspaceMatcher } from "../util/elmWorkspaceMatcher";
import { SymbolInformationTranslator } from "../util/symbolTranslator";
import { ThrottledCancellationToken } from "../cancellation";
import { IDocumentSymbolParams } from "./paramsExtensions";

type DocumentSymbolResult =
  | SymbolInformation[]
  | DocumentSymbol[]
  | null
  | undefined;

export class DocumentSymbolProvider {
  private connection: Connection;

  constructor() {
    this.connection = container.resolve<Connection>("Connection");
    this.connection.onDocumentSymbol(
      new ElmWorkspaceMatcher((param: DocumentSymbolParams) =>
        URI.parse(param.textDocument.uri),
      ).handle(this.handleDocumentSymbolRequest.bind(this)),
    );
  }

  private handleDocumentSymbolRequest = (
    param: IDocumentSymbolParams,
    token?: CancellationToken,
  ): DocumentSymbolResult => {
    this.connection.console.info(`Document Symbols were requested`);
    const symbolInformationList: SymbolInformation[] = [];

    const tree: Tree = param.sourceFile.tree;

    const cancellationToken = token
      ? new ThrottledCancellationToken(token)
      : undefined;

    const traverse: (node: SyntaxNode) => void = (node: SyntaxNode): void => {
      cancellationToken?.throwIfCancellationRequested();

      const symbolInformation =
        SymbolInformationTranslator.translateNodeToSymbolInformation(
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

    traverse(tree.rootNode);

    return symbolInformationList;
  };
}
